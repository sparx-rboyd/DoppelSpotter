import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type DocumentReference } from '@google-cloud/firestore';
import { fetchDatasetItems, startDeepSearchRun } from '@/lib/apify/client';
import { chatCompletion } from '@/lib/analysis/openrouter';
import { areUserPreferenceHintsTerminal } from '@/lib/analysis/user-preference-hints';
import {
  DISCORD_CLASSIFICATION_SYSTEM_PROMPT,
  GOOGLE_CLASSIFICATION_SYSTEM_PROMPT,
  SCAN_SUMMARY_SYSTEM_PROMPT,
  buildDiscordChunkAnalysisPrompt,
  buildDiscordFinalSelectionPrompt,
  buildDiscordFinalSelectionSystemPrompt,
  buildGoogleFinalSelectionSystemPrompt,
  buildGoogleFinalSelectionPrompt,
  buildGoogleChunkAnalysisPrompt,
  buildScanSummaryPrompt,
  formatLlmPromptForDebug,
} from '@/lib/analysis/prompts';
import {
  parseDiscordChunkAnalysisOutput,
  parseGoogleChunkAnalysisOutput,
  parseSuggestedSearchOutput,
  parseScanSummaryOutput,
  type DiscordChunkAnalysisItem,
  type DiscordRunContext,
  type DiscordServerCandidate,
  type DiscordStoredFindingRawData,
  type GoogleChunkAnalysisItem,
  type GoogleRunContext,
  type GoogleSearchCandidate,
  type GoogleSearchSighting,
  type GoogleStoredFindingRawData,
} from '@/lib/analysis/types';
import type { BrandProfile, Finding, Scan, ActorRunInfo, GoogleScannerId } from '@/lib/types';
import { normalizeAllowAiDeepSearches, normalizeMaxAiDeepSearches } from '@/lib/brands';
import { loadBrandFindingTaxonomy } from '@/lib/findings-taxonomy';
import {
  buildGoogleScannerQuery,
  getScannerConfigById,
  getScannerConfigBySource,
  sanitizeGoogleQueryForDisplay,
  type GoogleScannerConfig,
  type ScannerConfig,
} from '@/lib/scan-sources';
import { sendCompletedScanSummaryEmailIfNeeded } from '@/lib/scan-summary-emails';
import { buildCountOnlyScanAiSummary, clearBrandActiveScanIfMatches, scanFromSnapshot } from '@/lib/scans';

/** Maximum items to analyse per actor run — caps AI analysis cost and latency */
const MAX_ITEMS_PER_RUN = 50;
const GOOGLE_ANALYSIS_CHUNK_SIZE = 10;
const GOOGLE_ANALYSIS_CONCURRENCY = 3;
const DISCORD_ANALYSIS_CHUNK_SIZE = 10;
const DISCORD_ANALYSIS_CONCURRENCY = 3;
const MAX_GOOGLE_CONTEXT_SOURCE_QUERIES = 5;
const GOOGLE_FINDING_ID_PREFIX = 'google';
const GOOGLE_RAW_DATA_VERSION = 2;
const DISCORD_FINDING_ID_PREFIX = 'discord';
const DISCORD_RAW_DATA_VERSION = 1;
type ScanDocHandle = {
  id: string;
  ref: DocumentReference;
};

const TRACKING_QUERY_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'msclkid',
]);

/**
 * POST /api/webhooks/apify
 *
 * Receives Apify webhook callbacks when an actor run completes.
 * Apify sends a POST to this URL with a JSON body containing run metadata.
 *
 * The webhook URL is configured per-run when triggering actors via the Apify API.
 * A shared secret is validated via the X-Apify-Webhook-Secret header.
 *
 * Reference: https://docs.apify.com/platform/integrations/webhooks
 */
export async function POST(request: NextRequest) {
  // Validate shared secret
  const secret = request.headers.get('X-Apify-Webhook-Secret');
  if (secret !== process.env.APIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let payload: {
    eventType: string;
    eventData: {
      actorId: string;
      actorRunId: string;
      status: string;
    };
    resource: {
      id: string;
      status: string;
      defaultDatasetId: string;
    };
  };

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { resource } = payload;

  if (!resource?.id) {
    return NextResponse.json({ error: 'Missing resource.id' }, { status: 400 });
  }

  // Look up the scan that owns this actor run using array-contains
  // (actorRunIds is a flat array of Apify run IDs stored on the scan document)
  const snapshot = await db
    .collection('scans')
    .where('actorRunIds', 'array-contains', resource.id)
    .limit(1)
    .get();

  if (snapshot.empty) {
    // Unknown run — acknowledge but take no action
    console.warn(`[webhook] No scan found for runId=${resource.id}`);
    return NextResponse.json({ received: true });
  }

  const scanDoc = snapshot.docs[0];
  const scan = scanDoc.data() as Scan;

  // If the scan was cancelled while this run was in flight, acknowledge and skip
  if (scan.status === 'cancelled') {
    console.log(`[webhook] Ignoring callback for run ${resource.id} — scan ${scanDoc.id} is cancelled`);
    return NextResponse.json({ received: true });
  }

  const existingRunStatus = scan.actorRuns?.[resource.id]?.status;
  if (existingRunStatus === 'succeeded' || existingRunStatus === 'failed') {
    console.log(`[webhook] Ignoring duplicate callback for run ${resource.id} — already ${existingRunStatus}`);
    return NextResponse.json({ received: true });
  }

  // Derive the public webhook URL from APP_URL so deep-search runs can call back here
  const webhookUrl = `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/webhooks/apify`;

  if (resource.status === 'SUCCEEDED') {
    const claim = await claimSucceededRunForProcessing(scanDoc.ref, resource.id, resource.defaultDatasetId);
    if (claim.kind === 'cancelled') {
      console.log(`[webhook] Ignoring callback for run ${resource.id} — scan ${scanDoc.id} is cancelled`);
      return NextResponse.json({ received: true });
    }
    if (claim.kind === 'waiting_for_preference_hints') {
      console.log(`[webhook] Deferring callback for run ${resource.id} — waiting for scan-level preference hints`);
      return NextResponse.json({ received: true });
    }
    if (claim.kind === 'already_terminal') {
      console.log(`[webhook] Ignoring duplicate callback for run ${resource.id} — already ${claim.status}`);
      return NextResponse.json({ received: true });
    }
    if (claim.kind === 'already_processing') {
      console.log(
        `[webhook] Ignoring duplicate callback for run ${resource.id} — already being processed (${claim.status})`,
      );
      return NextResponse.json({ received: true });
    }
    if (claim.kind === 'missing') {
      console.warn(`[webhook] No actor run metadata found for runId=${resource.id} on scan ${scanDoc.id}`);
      return NextResponse.json({ received: true });
    }

    try {
      await handleSucceededRun({
        runId: resource.id,
        datasetId: resource.defaultDatasetId,
        scanDoc,
        scan: claim.scan,
        webhookUrl,
      });
    } catch (err) {
      await recoverFromSucceededRunError({
        scanDoc,
        runId: resource.id,
        err,
      });
    }
  } else if (resource.status === 'FAILED' || resource.status === 'ABORTED') {
    console.warn(`[webhook] Actor run ${resource.id} ended with status: ${resource.status}`);
    await markActorRunComplete(scanDoc, resource.id, 'failed');
  }

  return NextResponse.json({ received: true });
}

type SucceededRunClaimResult =
  | { kind: 'claimed'; scan: Scan }
  | { kind: 'waiting_for_preference_hints' }
  | { kind: 'cancelled' }
  | { kind: 'already_terminal'; status: 'succeeded' | 'failed' }
  | { kind: 'already_processing'; status: 'waiting_for_preference_hints' | 'fetching_dataset' | 'analysing' }
  | { kind: 'missing' };

/**
 * Claim a successful webhook callback before any dataset fetch / AI analysis begins.
 *
 * This transaction closes the race where duplicate Apify callbacks arrive close
 * together: only the winner is allowed to transition the run into
 * `fetching_dataset`, and any concurrent loser exits before doing expensive work.
 */
async function claimSucceededRunForProcessing(
  scanRef: DocumentReference,
  runId: string,
  datasetId?: string,
): Promise<SucceededRunClaimResult> {
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanRef);
    if (!freshSnap.exists) return { kind: 'missing' };

    const fresh = freshSnap.data() as Scan;
    if (fresh.status === 'cancelled') return { kind: 'cancelled' };

    const run = fresh.actorRuns?.[runId];
    if (!run) return { kind: 'missing' };

    if (run.status === 'succeeded' || run.status === 'failed') {
      return { kind: 'already_terminal', status: run.status };
    }

    if (!areUserPreferenceHintsTerminal(fresh)) {
      if (run.status === 'waiting_for_preference_hints') {
        return { kind: 'already_processing', status: 'waiting_for_preference_hints' };
      }
      if (run.status === 'fetching_dataset' || run.status === 'analysing') {
        return { kind: 'already_processing', status: run.status };
      }

      tx.update(scanRef, {
        [`actorRuns.${runId}.status`]: 'waiting_for_preference_hints',
        ...(typeof datasetId === 'string' && datasetId.length > 0
          ? { [`actorRuns.${runId}.datasetId`]: datasetId }
          : {}),
      });

      return { kind: 'waiting_for_preference_hints' };
    }

    if (
      run.status === 'waiting_for_preference_hints'
      || run.status === 'fetching_dataset'
      || run.status === 'analysing'
    ) {
      if (run.status === 'waiting_for_preference_hints') {
        tx.update(scanRef, {
          [`actorRuns.${runId}.status`]: 'fetching_dataset',
          ...(typeof datasetId === 'string' && datasetId.length > 0
            ? { [`actorRuns.${runId}.datasetId`]: datasetId }
            : {}),
        });
        return { kind: 'claimed', scan: fresh };
      }

      return { kind: 'already_processing', status: run.status };
    }

    tx.update(scanRef, {
      [`actorRuns.${runId}.status`]: 'fetching_dataset',
      ...(typeof datasetId === 'string' && datasetId.length > 0
        ? { [`actorRuns.${runId}.datasetId`]: datasetId }
        : {}),
    });

    return { kind: 'claimed', scan: fresh };
  });
}

/**
 * Handle a succeeded actor run: fetch dataset items, run AI analysis on each,
 * write findings to Firestore, then mark the actor run as complete.
 */
async function handleSucceededRun({
  runId,
  datasetId,
  scanDoc,
  scan,
  webhookUrl,
}: {
  runId: string;
  datasetId: string;
  scanDoc: ScanDocHandle;
  scan: Scan;
  webhookUrl: string;
}) {
  // Fetch the brand profile for context in the AI analysis prompt
  const brandDoc = await db.collection('brands').doc(scan.brandId).get();
  if (!brandDoc.exists) {
    console.error(`[webhook] Brand ${scan.brandId} not found for scan ${scanDoc.id}`);
    await markActorRunComplete(scanDoc, runId, 'failed');
    return;
  }
  const brand = brandDoc.data() as BrandProfile;

  // Determine the source (surface) for this actor run
  const actorRunInfo = scan.actorRuns?.[runId];
  const scannerConfig = resolveScannerConfig(actorRunInfo);
  const source = actorRunInfo?.source ?? scannerConfig.source;
  const actorId = actorRunInfo?.actorId ?? scannerConfig.actorId;
  const searchDepth = actorRunInfo?.searchDepth ?? 0;
  const searchQuery = actorRunInfo?.searchQuery;
  const displayQuery = actorRunInfo?.displayQuery ?? (
    searchQuery
      ? (scannerConfig.kind === 'google' ? sanitizeGoogleQueryForDisplay(searchQuery) : searchQuery)
      : undefined
  );
  const maxSuggestedSearches = normalizeMaxAiDeepSearches(brand.maxAiDeepSearches);
  const userPreferenceHints = scan.userPreferenceHints;
  const previousFindingUrls = scannerConfig.kind === 'google'
    ? await loadPreviousFindingUrls({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousDiscordServerIds = scannerConfig.kind === 'discord'
    ? await loadPreviousDiscordServerIds({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const existingTaxonomy = await loadBrandFindingTaxonomy({
    brandId: scan.brandId,
    userId: scan.userId,
  });

  // Fetch raw scraping results from Apify's dataset
  let items: Record<string, unknown>[];
  try {
    items = await fetchDatasetItems(datasetId);
  } catch (err) {
    console.error(`[webhook] Failed to fetch dataset ${datasetId}:`, err);
    await markActorRunComplete(scanDoc, runId, 'failed');
    return;
  }

  if (items.length === 0) {
    console.log(`[webhook] No items in dataset ${datasetId} for actor ${actorId}`);
    await markActorRunComplete(scanDoc, runId, 'succeeded');
    return;
  }

  // Cap items to control AI analysis cost
  const itemsToAnalyse = items.slice(0, MAX_ITEMS_PER_RUN);
  if (items.length > MAX_ITEMS_PER_RUN) {
    console.warn(
      `[webhook] Dataset ${datasetId} has ${items.length} items — truncating to ${MAX_ITEMS_PER_RUN}`,
    );
  }

  // Phase 2 → Phase 3: signal that AI analysis is starting, and record total item count
  await scanDoc.ref.update({
    [`actorRuns.${runId}.status`]: 'analysing',
    [`actorRuns.${runId}.itemCount`]: itemsToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: 0,
  });

  let newFindingCount = 0;
  let skippedDuplicateCount = 0;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };

  const {
    findingCount,
    suggestedSearches,
    counts: batchCounts,
    skippedDuplicateCount: batchSkippedDuplicateCount,
  } = scannerConfig.kind === 'google'
    ? await analyseAndWriteGoogleBatch({
      scanDoc,
      scan,
      brand,
      source,
      actorId,
      datasetId,
      runId,
      items: itemsToAnalyse,
      searchDepth,
      searchQuery,
      displayQuery,
      userPreferenceHints,
      previousFindingUrls,
      existingTaxonomy,
      scannerConfig,
    })
    : await analyseAndWriteDiscordBatch({
      scanDoc,
      scan,
      brand,
      source,
      actorId,
      datasetId,
      runId,
      items: itemsToAnalyse,
      searchDepth,
      searchQuery,
      displayQuery,
      userPreferenceHints,
      previousServerIds: previousDiscordServerIds,
      existingTaxonomy,
      scannerConfig,
    });
  newFindingCount = findingCount;
  skippedDuplicateCount = batchSkippedDuplicateCount;
  counts.high = batchCounts.high;
  counts.medium = batchCounts.medium;
  counts.low = batchCounts.low;
  counts.nonHit = batchCounts.nonHit;

  // Trigger deep follow-up searches only when this is a depth-0 run and the
  // brand still allows AI-requested deeper searches.
  if (
    suggestedSearches &&
    suggestedSearches.length > 0 &&
    searchDepth === 0 &&
    normalizeAllowAiDeepSearches(brand.allowAiDeepSearches)
  ) {
    const reservedQueries = await reserveSuggestedSearches({
      scanDoc,
      runId,
      suggestedSearches,
      scannerConfig,
      maxSuggestedSearches,
    });
    if (reservedQueries.length > 0) {
      await triggerDeepSearches({
        scanDoc,
        scan,
        brand,
        suggestedSearches: reservedQueries,
        maxSuggestedSearches,
        webhookUrl,
        scannerConfig,
      });
    }
  }

  console.log(
    `[webhook] Actor ${actorId} (run ${runId}, scanner ${scannerConfig.id}, depth ${searchDepth}): ${newFindingCount} findings written from ${itemsToAnalyse.length} items, ${skippedDuplicateCount} skipped as previous duplicates (mode: ${scannerConfig.kind}-batch)`,
  );

  await markActorRunComplete(scanDoc, runId, 'succeeded', newFindingCount, counts, skippedDuplicateCount);
}

async function recoverFromSucceededRunError({
  scanDoc,
  runId,
  err,
}: {
  scanDoc: ScanDocHandle;
  runId: string;
  err: unknown;
}) {
  console.error(`[webhook] Unexpected error while processing succeeded run ${runId}:`, err);

  await markActorRunComplete(
    scanDoc,
    runId,
    'failed',
    0,
    { high: 0, medium: 0, low: 0, nonHit: 0 },
    0,
    { reconcilePersistedCounts: true },
  );
}

async function loadPreviousFindingUrls({
  brandId,
  userId,
  currentScanId,
}: {
  brandId: string;
  userId: string;
  currentScanId: string;
}): Promise<Set<string>> {
  const previousFindingsSnap = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .select('scanId', 'url')
    .get();

  const urls = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; url?: string };
    if (data.scanId === currentScanId || typeof data.url !== 'string' || data.url.trim().length === 0) {
      continue;
    }

    const normalizedUrl = normalizeUrlForFinding(data.url);
    if (normalizedUrl) {
      urls.add(normalizedUrl);
    }
  }

  return urls;
}

async function loadPreviousDiscordServerIds({
  brandId,
  userId,
  currentScanId,
}: {
  brandId: string;
  userId: string;
  currentScanId: string;
}): Promise<Set<string>> {
  const previousFindingsSnap = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', userId)
    .select('scanId', 'rawData')
    .get();

  const serverIds = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const serverId = readDiscordStoredFindingRawData(data.rawData)?.server.id;
    if (typeof serverId === 'string' && serverId.trim().length > 0) {
      serverIds.add(serverId.trim());
    }
  }

  return serverIds;
}

/**
 * Batch mode: send all SERP pages to AI analysis in one call, then write one Finding
 * per individual search result assessed. Returns the count of non-false-positive
 * findings and any suggested follow-up search queries.
 */
async function analyseAndWriteGoogleBatch({
  scanDoc,
  scan,
  brand,
  source,
  scannerConfig,
  actorId,
  datasetId,
  runId,
  items,
  searchDepth,
  searchQuery,
  displayQuery,
  userPreferenceHints,
  previousFindingUrls,
  existingTaxonomy,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  scannerConfig: GoogleScannerConfig;
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  userPreferenceHints?: Scan['userPreferenceHints'];
  previousFindingUrls?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const canRunDeepSearchSelection = searchDepth === 0 && normalizeAllowAiDeepSearches(brand.allowAiDeepSearches);
  const maxSuggestedSearches = normalizeMaxAiDeepSearches(brand.maxAiDeepSearches);

  const normalizedRun = normalizeGoogleSerpRun({
    source,
    scannerId: scannerConfig.id,
    runId,
    searchDepth,
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousFindingUrls?.has(candidate.normalizedUrl),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await scanDoc.ref.update({
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, GOOGLE_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    GOOGLE_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<GoogleChunkAnalysisResult> => {
      const prompt = buildGoogleChunkAnalysisPrompt({
        scanner: scannerConfig,
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(GOOGLE_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        const chunkResult = await analyseGoogleChunk({
          candidates: chunk,
          prompt,
          llmAnalysisPrompt,
        });

        return chunkResult;
      } catch (err) {
        console.error(`[webhook] Google chunk analysis failed for dataset ${datasetId} (chunk ${chunkIndex + 1}/${chunks.length}):`, err);

        const fallbackOutcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();
        for (const candidate of chunk) {
          fallbackOutcomes.set(candidate.normalizedUrl, {
            candidate,
            outcome: buildGoogleFallbackOutcome(
              'AI analysis failed for this chunk. Raw data is preserved for manual review.',
              undefined,
              llmAnalysisPrompt,
            ),
          });
        }

        return {
          outcomes: fallbackOutcomes,
        };
      } finally {
        await scanDoc.ref.update({
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    for (const [normalizedUrl, value] of chunkResult.outcomes.entries()) {
      outcomes.set(normalizedUrl, value);
    }
  }

  if (canRunDeepSearchSelection) {
    suggestedSearches = await finalizeSuggestedSearches({
      brand,
      scannerConfig,
      runContext: normalizedRun.runContext,
      maxSuggestedSearches,
    });
  }

  for (const { candidate, outcome } of outcomes.values()) {
    const delta = await upsertGoogleFinding({
      scanDoc,
      scan,
      source,
      actorId,
      runId,
      searchDepth,
      searchQuery,
      displayQuery,
      candidate,
      runContext: normalizedRun.runContext,
      outcome,
      scannerConfig,
    });

    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
}

async function analyseAndWriteDiscordBatch({
  scanDoc,
  scan,
  brand,
  source,
  scannerConfig,
  actorId,
  datasetId,
  runId,
  items,
  searchDepth,
  searchQuery,
  displayQuery,
  userPreferenceHints,
  previousServerIds,
  existingTaxonomy,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  userPreferenceHints?: Scan['userPreferenceHints'];
  previousServerIds?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const canRunDeepSearchSelection = searchDepth === 0 && normalizeAllowAiDeepSearches(brand.allowAiDeepSearches);
  const maxSuggestedSearches = normalizeMaxAiDeepSearches(brand.maxAiDeepSearches);

  const normalizedRun = normalizeDiscordServerRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousServerIds?.has(candidate.serverId),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await scanDoc.ref.update({
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, DISCORD_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    DISCORD_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<DiscordChunkAnalysisResult> => {
      const prompt = buildDiscordChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(DISCORD_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await analyseDiscordChunk({
          candidates: chunk,
          prompt,
          llmAnalysisPrompt,
        });
      } catch (err) {
        console.error(`[webhook] Discord chunk analysis failed for dataset ${datasetId} (chunk ${chunkIndex + 1}/${chunks.length}):`, err);

        const fallbackOutcomes = new Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>();
        for (const candidate of chunk) {
          fallbackOutcomes.set(candidate.serverId, {
            candidate,
            outcome: buildDiscordFallbackOutcome(
              'AI analysis failed for this chunk. Raw data is preserved for manual review.',
              undefined,
              llmAnalysisPrompt,
            ),
          });
        }

        return {
          outcomes: fallbackOutcomes,
        };
      } finally {
        await scanDoc.ref.update({
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    for (const [serverId, value] of chunkResult.outcomes.entries()) {
      outcomes.set(serverId, value);
    }
  }

  if (canRunDeepSearchSelection) {
    suggestedSearches = await finalizeDiscordSuggestedSearches({
      brand,
      scannerConfig,
      runContext: normalizedRun.runContext,
      maxSuggestedSearches,
    });
  }

  for (const { candidate, outcome } of outcomes.values()) {
    const delta = await upsertDiscordFinding({
      scanDoc,
      scan,
      source,
      actorId,
      runId,
      searchDepth,
      searchQuery,
      displayQuery,
      candidate,
      runContext: normalizedRun.runContext,
      outcome,
      scannerConfig,
    });

    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
}

type GoogleFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type GoogleChunkAnalysisResult = {
  outcomes: Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>;
};

type DiscordFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type DiscordChunkAnalysisResult = {
  outcomes: Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>;
};

type FindingDelta = {
  findingCount: number;
  counts: { high: number; medium: number; low: number; nonHit: number };
};

type ScanFindingTotals = {
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  nonHitCount: number;
  ignoredCount: number;
  addressedCount: number;
  skippedCount: number;
};

type MarkActorRunCompleteOptions = {
  reconcilePersistedCounts?: boolean;
};

type ScanSummaryFindingInput = Pick<Finding, 'severity' | 'title' | 'llmAnalysis' | 'source' | 'url'>;

type MarkActorRunCompleteResult = {
  needsSummary: boolean;
};

function normalizeGoogleSerpRun({
  source,
  scannerId,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  items,
}: {
  source: Finding['source'];
  scannerId: GoogleScannerConfig['id'];
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: GoogleSearchCandidate[]; runContext: GoogleRunContext } {
  const candidateMap = new Map<string, GoogleSearchCandidate>();
  const relatedQueries = new Set<string>();
  const peopleAlsoAsk = new Set<string>();
  const sourceQueries = new Set<string>();
  let nextResultId = 1;

  for (const item of items) {
    const pageNumber = readGooglePageNumber(item);
    const rawSourceQuery = searchQuery ?? readGoogleSourceQuery(item);
    const sourceQuery = displayQuery ?? (rawSourceQuery ? sanitizeGoogleQueryForDisplay(rawSourceQuery) : undefined);
    if (sourceQuery) sourceQueries.add(sourceQuery);

    for (const relatedQuery of readGoogleTitles(item.relatedQueries)) {
      relatedQueries.add(relatedQuery);
    }
    for (const question of readGoogleTitles(item.peopleAlsoAsk)) {
      peopleAlsoAsk.add(question);
    }

    const organicResults = Array.isArray(item.organicResults) ? item.organicResults : [];
    for (const result of organicResults) {
      if (typeof result !== 'object' || result === null) continue;

      const rawUrl = typeof result.url === 'string' ? result.url.trim() : '';
      const normalizedUrl = normalizeUrlForFinding(rawUrl);
      if (!normalizedUrl) continue;

      const title = typeof result.title === 'string' ? result.title.trim() : normalizedUrl;
      const displayedUrl = typeof result.displayedUrl === 'string' ? result.displayedUrl.trim() : undefined;
      const description = typeof result.description === 'string' ? result.description.trim() : undefined;
      const emphasizedKeywords = Array.isArray(result.emphasizedKeywords)
        ? (result.emphasizedKeywords as unknown[])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
        : [];
      const position = typeof result.position === 'number'
        ? result.position
        : (typeof result.position === 'string' && /^\d+$/.test(result.position) ? Number(result.position) : undefined);

      const sighting: GoogleSearchSighting = {
        runId,
        source,
        scannerId,
        searchDepth,
        page: pageNumber,
        title,
        ...(rawSourceQuery ? { searchQuery: rawSourceQuery } : {}),
        ...(sourceQuery ? { displayQuery: sourceQuery } : {}),
        ...(typeof position === 'number' ? { position } : {}),
        ...(displayedUrl ? { displayedUrl } : {}),
        ...(description ? { description } : {}),
        ...(emphasizedKeywords.length > 0 ? { emphasizedKeywords } : {}),
      };

      const existing = candidateMap.get(normalizedUrl);
      if (existing) {
        existing.sightings = mergeGoogleSightings(existing.sightings, [sighting]);
        existing.pageNumbers = uniqueSortedNumbers(existing.sightings.map((value) => value.page));
        existing.positions = uniqueSortedNumbers(existing.sightings.map((value) => value.position).filter((value): value is number => typeof value === 'number'));
        if (!existing.description && description) existing.description = description;
        if (!existing.displayedUrl && displayedUrl) existing.displayedUrl = displayedUrl;
        existing.emphasizedKeywords = uniqueStrings([...existing.emphasizedKeywords ?? [], ...emphasizedKeywords]);
        continue;
      }

      candidateMap.set(normalizedUrl, {
        resultId: `r${nextResultId++}`,
        url: normalizedUrl,
        normalizedUrl,
        title,
        displayedUrl,
        description,
        emphasizedKeywords,
        pageNumbers: [pageNumber],
        positions: position !== undefined ? [position] : [],
        sightings: [sighting],
      });
    }
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)).slice(0, MAX_GOOGLE_CONTEXT_SOURCE_QUERIES),
      relatedQueries: uniqueStrings(Array.from(relatedQueries)),
      peopleAlsoAsk: uniqueStrings(Array.from(peopleAlsoAsk)),
    },
  };
}

function normalizeDiscordServerRun({
  searchQuery,
  displayQuery,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: DiscordServerCandidate[]; runContext: DiscordRunContext } {
  const candidateMap = new Map<string, DiscordServerCandidate>();
  const sourceQueries = new Set<string>();
  const observedKeywords = new Set<string>();
  const observedCategories = new Set<string>();
  const observedLocales = new Set<string>();
  const sampleServerNames = new Set<string>();
  let nextResultId = 1;

  for (const sourceQuery of readDiscordSourceQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const serverId = readDiscordServerId(item);
    const vanityUrlCode = readDiscordVanityUrlCode(item);
    if (!serverId || !vanityUrlCode) continue;

    const inviteUrl = buildDiscordInviteUrl(vanityUrlCode);
    if (!inviteUrl) continue;

    const name = readDiscordServerName(item) ?? `Discord server ${serverId}`;
    const description = readOptionalTrimmedString(item.description);
    const keywords = readDiscordStringArray(item.keywords);
    const categories = readDiscordCategoryNames(item.categories);
    const primaryCategory = readDiscordPrimaryCategory(item.primary_category);
    const features = readDiscordStringArray(item.features);
    const preferredLocale = readOptionalTrimmedString(item.preferred_locale);
    const approximateMemberCount = readOptionalFiniteNumber(item.approximate_member_count);
    const approximatePresenceCount = readOptionalFiniteNumber(item.approximate_presence_count);
    const premiumSubscriptionCount = readOptionalFiniteNumber(item.premium_subscription_count);
    const isPublished = typeof item.is_published === 'boolean' ? item.is_published : undefined;

    sampleServerNames.add(name);
    for (const keyword of keywords) observedKeywords.add(keyword);
    for (const category of categories) observedCategories.add(category);
    if (primaryCategory) observedCategories.add(primaryCategory);
    if (preferredLocale) observedLocales.add(preferredLocale);

    const existing = candidateMap.get(serverId);
    if (existing) {
      existing.keywords = uniqueStrings([...existing.keywords, ...keywords]);
      existing.categories = uniqueStrings([...existing.categories, ...categories]);
      existing.features = uniqueStrings([...existing.features, ...features]);
      if (!existing.description && description) existing.description = description;
      if (!existing.primaryCategory && primaryCategory) existing.primaryCategory = primaryCategory;
      if (existing.approximateMemberCount === undefined && approximateMemberCount !== undefined) {
        existing.approximateMemberCount = approximateMemberCount;
      }
      if (existing.approximatePresenceCount === undefined && approximatePresenceCount !== undefined) {
        existing.approximatePresenceCount = approximatePresenceCount;
      }
      if (existing.premiumSubscriptionCount === undefined && premiumSubscriptionCount !== undefined) {
        existing.premiumSubscriptionCount = premiumSubscriptionCount;
      }
      if (!existing.preferredLocale && preferredLocale) existing.preferredLocale = preferredLocale;
      if (existing.isPublished === undefined && isPublished !== undefined) existing.isPublished = isPublished;
      continue;
    }

    candidateMap.set(serverId, {
      resultId: `d${nextResultId++}`,
      serverId,
      inviteUrl,
      vanityUrlCode,
      name,
      ...(description ? { description } : {}),
      keywords,
      categories,
      ...(primaryCategory ? { primaryCategory } : {}),
      features,
      ...(approximateMemberCount !== undefined ? { approximateMemberCount } : {}),
      ...(approximatePresenceCount !== undefined ? { approximatePresenceCount } : {}),
      ...(premiumSubscriptionCount !== undefined ? { premiumSubscriptionCount } : {}),
      ...(preferredLocale ? { preferredLocale } : {}),
      ...(isPublished !== undefined ? { isPublished } : {}),
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      observedKeywords: uniqueStrings(Array.from(observedKeywords)),
      observedCategories: uniqueStrings(Array.from(observedCategories)),
      observedLocales: uniqueStrings(Array.from(observedLocales)),
      sampleServerNames: uniqueStrings(Array.from(sampleServerNames)).slice(0, 12),
    },
  };
}

async function analyseGoogleChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: GoogleSearchCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<GoogleChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: GOOGLE_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseGoogleChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse Google chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  const outcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId);
    outcomes.set(candidate.normalizedUrl, {
      candidate,
      outcome: item
        ? buildGoogleFindingOutcome(item, raw, llmAnalysisPrompt)
        : buildGoogleFallbackOutcome(
            'AI analysis returned no assessment for this result. Raw data is preserved for manual review.',
            raw,
            llmAnalysisPrompt,
          ),
    });
  }

  return { outcomes };
}

async function analyseDiscordChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: DiscordServerCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<DiscordChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: DISCORD_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseDiscordChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse Discord chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  const outcomes = new Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId);
    outcomes.set(candidate.serverId, {
      candidate,
      outcome: item
        ? buildDiscordFindingOutcome(item, raw, llmAnalysisPrompt)
        : buildDiscordFallbackOutcome(
            'AI analysis returned no assessment for this server. Raw data is preserved for manual review.',
            raw,
            llmAnalysisPrompt,
          ),
    });
  }

  return { outcomes };
}

async function analyseGoogleFinalSelection({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: GoogleScannerConfig;
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildGoogleFinalSelectionPrompt({
    scanner: scannerConfig,
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildGoogleFinalSelectionSystemPrompt(maxSuggestedSearches, scannerConfig);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseSuggestedSearchOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse Google final selection output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
}

async function analyseDiscordFinalSelection({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: ScannerConfig;
  runContext: DiscordRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildDiscordFinalSelectionPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildDiscordFinalSelectionSystemPrompt(maxSuggestedSearches, scannerConfig);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseSuggestedSearchOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse Discord final selection output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
}

async function finalizeSuggestedSearches({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: GoogleScannerConfig;
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseGoogleFinalSelection({
      brand,
      scannerConfig,
      runContext,
      maxSuggestedSearches,
    });

    if (!llmSuggestedSearches || llmSuggestedSearches.length === 0) {
      console.log(
        `[webhook] Google deep-search final selection relatedQueries=${runContext.relatedQueries.length} peopleAlsoAsk=${runContext.peopleAlsoAsk.length} selected=[]`,
      );
      return undefined;
    }

    const sourceQueryKeys = new Set(runContext.sourceQueries.map(normalizeSuggestedSearchKey));
    const filteredSuggestions = llmSuggestedSearches.filter((query) => !sourceQueryKeys.has(normalizeSuggestedSearchKey(query)));
    if (filteredSuggestions.length === 0) {
      console.warn('[webhook] Google final deep-search selection returned only source-query duplicates');
      return undefined;
    }

    console.log(
      `[webhook] Google deep-search final selection relatedQueries=${runContext.relatedQueries.length} peopleAlsoAsk=${runContext.peopleAlsoAsk.length} selected=${JSON.stringify(filteredSuggestions)}`,
    );
    return filteredSuggestions;
  } catch (err) {
    console.error('[webhook] Google final deep-search selection failed:', err);
    return undefined;
  }
}

async function finalizeDiscordSuggestedSearches({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: ScannerConfig;
  runContext: DiscordRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseDiscordFinalSelection({
      brand,
      scannerConfig,
      runContext,
      maxSuggestedSearches,
    });

    if (!llmSuggestedSearches || llmSuggestedSearches.length === 0) {
      console.log(
        `[webhook] Discord deep-search final selection keywords=${runContext.observedKeywords.length} categories=${runContext.observedCategories.length} selected=[]`,
      );
      return undefined;
    }

    const sourceQueryKeys = new Set(runContext.sourceQueries.map(normalizeSuggestedSearchKey));
    const filteredSuggestions = llmSuggestedSearches.filter((query) => !sourceQueryKeys.has(normalizeSuggestedSearchKey(query)));
    if (filteredSuggestions.length === 0) {
      console.warn('[webhook] Discord final deep-search selection returned only source-query duplicates');
      return undefined;
    }

    console.log(
      `[webhook] Discord deep-search final selection keywords=${runContext.observedKeywords.length} categories=${runContext.observedCategories.length} selected=${JSON.stringify(filteredSuggestions)}`,
    );
    return filteredSuggestions;
  } catch (err) {
    console.error('[webhook] Discord final deep-search selection failed:', err);
    return undefined;
  }
}

async function upsertGoogleFinding({
  scanDoc,
  scan,
  source,
  scannerConfig,
  actorId,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  candidate,
  runContext,
  outcome,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  source: Finding['source'];
  scannerConfig: GoogleScannerConfig;
  actorId: string;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  candidate: GoogleSearchCandidate;
  runContext: GoogleRunContext;
  outcome: GoogleFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildGoogleFindingId(scanId, candidate.normalizedUrl));

  return db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredGoogleOutcome(existing, outcome);
    const mergedRawData = buildGoogleStoredFindingRawData({
      existingRawData: existing?.rawData,
      candidate,
      runContext,
      source,
      scannerConfig,
      runId,
      searchDepth,
      searchQuery,
      displayQuery,
      classificationSource: preferredOutcome.classificationSource,
    });
    const preferredSource = choosePreferredFindingSource(existing?.source, source);

    const previousState = existing ? getFindingCountState(existing) : emptyFindingCountState();
    const nextState = getOutcomeCountState(preferredOutcome);

    if (!existing) {
      const finding: Omit<Finding, 'id'> = {
        scanId,
        brandId: scan.brandId,
        userId: scan.userId,
        source: preferredSource,
        actorId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { theme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.normalizedUrl,
        rawData: mergedRawData,
        isFalsePositive: preferredOutcome.isFalsePositive,
        ...(preferredOutcome.isFalsePositive && {
          isIgnored: true,
          ignoredAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        }),
      ...(typeof preferredOutcome.llmAnalysisPrompt === 'string' && {
        llmAnalysisPrompt: preferredOutcome.llmAnalysisPrompt,
      }),
        ...(typeof preferredOutcome.rawLlmResponse === 'string' && {
          rawLlmResponse: preferredOutcome.rawLlmResponse,
        }),
        createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
      };
      tx.set(findingRef, finding);
      return diffFindingStates(previousState, nextState);
    }

    const updates: Record<string, unknown> = {
      source: preferredSource,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: preferredOutcome.theme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.normalizedUrl,
      rawData: mergedRawData,
      isFalsePositive: preferredOutcome.isFalsePositive,
    };

    const llmAnalysisPrompt = preferredOutcome.llmAnalysisPrompt ?? existing.llmAnalysisPrompt;
    if (typeof llmAnalysisPrompt === 'string') {
      updates.llmAnalysisPrompt = llmAnalysisPrompt;
    }

    const rawLlmResponse = preferredOutcome.rawLlmResponse ?? existing.rawLlmResponse;
    if (typeof rawLlmResponse === 'string') {
      updates.rawLlmResponse = rawLlmResponse;
    }

    if (preferredOutcome.isFalsePositive) {
      updates.isIgnored = true;
      if (existing.isIgnored !== true) {
        updates.ignoredAt = FieldValue.serverTimestamp();
      }
      updates.isAddressed = false;
      if (existing.addressedAt) {
        updates.addressedAt = FieldValue.delete();
      }
    } else {
      updates.isIgnored = false;
      if (existing.ignoredAt) {
        updates.ignoredAt = FieldValue.delete();
      }
    }

    tx.update(findingRef, updates);
    return diffFindingStates(previousState, nextState);
  });
}

async function upsertDiscordFinding({
  scanDoc,
  scan,
  source,
  scannerConfig,
  actorId,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  candidate,
  runContext,
  outcome,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  actorId: string;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  candidate: DiscordServerCandidate;
  runContext: DiscordRunContext;
  outcome: DiscordFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildDiscordFindingId(scanId, candidate.serverId));

  return db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredDiscordOutcome(existing, outcome);
    const mergedRawData = buildDiscordStoredFindingRawData({
      existingRawData: existing?.rawData,
      candidate,
      runContext,
      source,
      scannerConfig,
      runId,
      searchDepth,
      searchQuery,
      displayQuery,
      classificationSource: preferredOutcome.classificationSource,
    });
    const preferredSource = choosePreferredFindingSource(existing?.source, source);

    const previousState = existing ? getFindingCountState(existing) : emptyFindingCountState();
    const nextState = getOutcomeCountState(preferredOutcome);

    if (!existing) {
      const finding: Omit<Finding, 'id'> = {
        scanId,
        brandId: scan.brandId,
        userId: scan.userId,
        source: preferredSource,
        actorId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { theme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.inviteUrl,
        rawData: mergedRawData,
        isFalsePositive: preferredOutcome.isFalsePositive,
        ...(preferredOutcome.isFalsePositive && {
          isIgnored: true,
          ignoredAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        }),
        ...(typeof preferredOutcome.llmAnalysisPrompt === 'string' && {
          llmAnalysisPrompt: preferredOutcome.llmAnalysisPrompt,
        }),
        ...(typeof preferredOutcome.rawLlmResponse === 'string' && {
          rawLlmResponse: preferredOutcome.rawLlmResponse,
        }),
        createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
      };
      tx.set(findingRef, finding);
      return diffFindingStates(previousState, nextState);
    }

    const updates: Record<string, unknown> = {
      source: preferredSource,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: preferredOutcome.theme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.inviteUrl,
      rawData: mergedRawData,
      isFalsePositive: preferredOutcome.isFalsePositive,
    };

    const llmAnalysisPrompt = preferredOutcome.llmAnalysisPrompt ?? existing.llmAnalysisPrompt;
    if (typeof llmAnalysisPrompt === 'string') {
      updates.llmAnalysisPrompt = llmAnalysisPrompt;
    }

    const rawLlmResponse = preferredOutcome.rawLlmResponse ?? existing.rawLlmResponse;
    if (typeof rawLlmResponse === 'string') {
      updates.rawLlmResponse = rawLlmResponse;
    }

    if (preferredOutcome.isFalsePositive) {
      updates.isIgnored = true;
      if (existing.isIgnored !== true) {
        updates.ignoredAt = FieldValue.serverTimestamp();
      }
      updates.isAddressed = false;
      if (existing.addressedAt) {
        updates.addressedAt = FieldValue.delete();
      }
    } else {
      updates.isIgnored = false;
      if (existing.ignoredAt) {
        updates.ignoredAt = FieldValue.delete();
      }
    }

    tx.update(findingRef, updates);
    return diffFindingStates(previousState, nextState);
  });
}

async function reserveSuggestedSearches({
  scanDoc,
  runId,
  suggestedSearches,
  scannerConfig,
  maxSuggestedSearches,
}: {
  scanDoc: ScanDocHandle;
  runId: string;
  suggestedSearches: string[];
  scannerConfig: ScannerConfig;
  maxSuggestedSearches: number;
}): Promise<string[]> {
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    const fresh = freshSnap.data() as Scan;
    const run = fresh.actorRuns?.[runId] as (ActorRunInfo & { deepSearchSuggestionsProcessed?: boolean }) | undefined;
    if (!run || run.deepSearchSuggestionsProcessed) {
      return [];
    }

    const existingQueries = new Set(
      Object.values(fresh.actorRuns ?? {})
        .flatMap((value) => {
          const existing: string[] = [];
          if (typeof value.searchQuery === 'string' && value.searchQuery.trim().length > 0) {
            existing.push(normalizeSuggestedSearchKey(value.searchQuery));
          }

          const existingScannerConfig = resolveScannerConfig(value);
          for (const suggestedQuery of value.suggestedSearches ?? []) {
            const executableQuery = buildExecutableSearchQuery(existingScannerConfig, suggestedQuery);
            if (executableQuery) {
              existing.push(normalizeSuggestedSearchKey(executableQuery));
            }
          }

          return existing;
        }),
    );

    const reserved = uniqueStrings(suggestedSearches)
      .filter((query) => {
        const executableQuery = buildExecutableSearchQuery(scannerConfig, query);
        return executableQuery.length > 0 && !existingQueries.has(normalizeSuggestedSearchKey(executableQuery));
      })
      .slice(0, maxSuggestedSearches);

    const updates: Record<string, unknown> = {
      [`actorRuns.${runId}.deepSearchSuggestionsProcessed`]: true,
    };
    if (reserved.length > 0) {
      updates[`actorRuns.${runId}.suggestedSearches`] = reserved;
    }

    tx.update(scanDoc.ref, updates);
    return reserved;
  });
}

/**
 * Start follow-up Google Search actor runs for each query suggested by AI analysis.
 * Caps total deep searches at the configured brand-specific deep-search limit,
 * but guarded here too). Adds the new runs to the scan document atomically so that
 * markActorRunComplete can correctly detect overall scan completion.
 */
async function triggerDeepSearches({
  scanDoc,
  scan,
  brand,
  suggestedSearches,
  maxSuggestedSearches,
  webhookUrl,
  scannerConfig,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  suggestedSearches: string[];
  maxSuggestedSearches: number;
  webhookUrl: string;
  scannerConfig: ScannerConfig;
}) {
  const queries = suggestedSearches.slice(0, maxSuggestedSearches);

  const startResults = await Promise.all(queries.map(async (query) => {
    try {
      const { runId, query: executableQuery, displayQuery } = await startDeepSearchRun({
        actor: scannerConfig,
        query,
        searchResultPages: brand.searchResultPages,
        webhookUrl,
      });

      return {
        runId,
        info: {
          scannerId: scannerConfig.id,
          actorId: scannerConfig.actorId,
          source: scannerConfig.source,
          status: 'running',
          skippedDuplicateCount: 0,
          searchDepth: 1,
          searchQuery: executableQuery,
          displayQuery,
        } satisfies ActorRunInfo,
      };
    } catch (err) {
      console.error(`[webhook] Failed to start deep search for "${query}":`, err);
      return null;
    }
  }));

  const newRunIds = startResults
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .map((result) => result.runId);
  const newActorRuns: Record<string, ActorRunInfo> = Object.fromEntries(
    startResults
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .map((result) => [result.runId, result.info]),
  );

  if (newRunIds.length === 0) return;

  // Atomically register the new runs on the scan document.
  // markActorRunComplete reads fresh actorRunIds.length inside its transaction,
  // so the completion check will correctly account for these additional runs.
  const updates: Record<string, unknown> = {
    actorRunIds: FieldValue.arrayUnion(...newRunIds),
  };
  for (const [runId, info] of Object.entries(newActorRuns)) {
    updates[`actorRuns.${runId}`] = info;
  }

  await scanDoc.ref.update(updates);

  // Also update the scan reference held in memory so this run's markActorRunComplete
  // sees the right total when it reads scan.actorRunIds. In practice this is already
  // handled by the fresh-snapshot read inside the transaction, but being explicit helps.
  void scan; // scan is stale after this point — always use fresh reads in transactions
}

function buildGoogleFindingOutcome(
  item: GoogleChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): GoogleFindingOutcome {
  return {
    severity: item.severity,
    title: item.title,
    theme: item.theme,
    analysis: item.analysis,
    isFalsePositive: item.isFalsePositive,
    llmAnalysisPrompt,
    rawLlmResponse,
    classificationSource: 'llm',
  };
}

function buildDiscordFindingOutcome(
  item: DiscordChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): DiscordFindingOutcome {
  return {
    severity: item.severity,
    title: item.title,
    theme: item.theme,
    analysis: item.analysis,
    isFalsePositive: item.isFalsePositive,
    llmAnalysisPrompt,
    rawLlmResponse,
    classificationSource: 'llm',
  };
}

function buildGoogleFallbackOutcome(
  message: string,
  rawLlmResponse?: string,
  llmAnalysisPrompt?: string,
): GoogleFindingOutcome {
  return {
    severity: 'medium',
    title: 'Unanalysed result — review manually',
    analysis: message,
    isFalsePositive: false,
    llmAnalysisPrompt,
    rawLlmResponse,
    classificationSource: 'fallback',
  };
}

function buildDiscordFallbackOutcome(
  message: string,
  rawLlmResponse?: string,
  llmAnalysisPrompt?: string,
): DiscordFindingOutcome {
  return {
    severity: 'medium',
    title: 'Unanalysed server - review manually',
    analysis: message,
    isFalsePositive: false,
    llmAnalysisPrompt,
    rawLlmResponse,
    classificationSource: 'fallback',
  };
}

function buildGoogleStoredFindingRawData({
  existingRawData,
  candidate,
  runContext,
  source,
  scannerConfig,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  classificationSource,
}: {
  existingRawData?: Record<string, unknown>;
  candidate: GoogleSearchCandidate;
  runContext: GoogleRunContext;
  source: Finding['source'];
  scannerConfig: GoogleScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): GoogleStoredFindingRawData {
  const existing = readGoogleStoredFindingRawData(existingRawData);
  const mergedSightings = mergeGoogleSightings(existing?.sightings, candidate.sightings);
  const mergedContext: GoogleRunContext = {
    sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
    relatedQueries: uniqueStrings([...(existing?.context.relatedQueries ?? []), ...runContext.relatedQueries]),
    peopleAlsoAsk: uniqueStrings([...(existing?.context.peopleAlsoAsk ?? []), ...runContext.peopleAlsoAsk]),
  };

  return {
    kind: 'google-normalized',
    version: GOOGLE_RAW_DATA_VERSION,
    normalizedUrl: candidate.normalizedUrl,
    result: {
      rawUrl: candidate.url,
      normalizedUrl: candidate.normalizedUrl,
      title: candidate.title,
      ...(candidate.displayedUrl ? { displayedUrl: candidate.displayedUrl } : {}),
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.emphasizedKeywords && candidate.emphasizedKeywords.length > 0
        ? { emphasizedKeywords: candidate.emphasizedKeywords }
        : {}),
    },
    sightings: mergedSightings,
    context: mergedContext,
    analysis: {
      source: classificationSource,
      runId,
      findingSource: source,
      scannerId: scannerConfig.id,
      searchDepth,
      ...(searchQuery ? { searchQuery } : {}),
      ...(displayQuery ? { displayQuery } : {}),
    },
  };
}

function readGoogleStoredFindingRawData(rawData?: Record<string, unknown>): GoogleStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'google-normalized') {
    return null;
  }
  if (rawData.version !== 1 && rawData.version !== GOOGLE_RAW_DATA_VERSION) {
    return null;
  }

  const result = typeof rawData.result === 'object' && rawData.result !== null ? rawData.result as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'google-normalized',
    version: GOOGLE_RAW_DATA_VERSION,
    normalizedUrl: typeof rawData.normalizedUrl === 'string' ? rawData.normalizedUrl : '',
    result: {
      rawUrl: typeof result.rawUrl === 'string' ? result.rawUrl : '',
      normalizedUrl: typeof result.normalizedUrl === 'string' ? result.normalizedUrl : '',
      title: typeof result.title === 'string' ? result.title : '',
      displayedUrl: typeof result.displayedUrl === 'string' ? result.displayedUrl : undefined,
      description: typeof result.description === 'string' ? result.description : undefined,
      emphasizedKeywords: Array.isArray(result.emphasizedKeywords)
        ? result.emphasizedKeywords.filter((value): value is string => typeof value === 'string')
        : undefined,
    },
    sightings: Array.isArray(rawData.sightings)
      ? rawData.sightings
        .map((value) => normalizeGoogleSearchSighting(value))
        .filter((value): value is GoogleSearchSighting => value !== null)
      : [],
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      relatedQueries: Array.isArray(context.relatedQueries)
        ? context.relatedQueries.filter((value): value is string => typeof value === 'string')
        : [],
      peopleAlsoAsk: Array.isArray(context.peopleAlsoAsk)
        ? context.peopleAlsoAsk.filter((value): value is string => typeof value === 'string')
        : [],
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'google',
      scannerId: isKnownGoogleScannerId(analysis.scannerId) ? analysis.scannerId : 'google-web',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string'
        ? analysis.displayQuery
        : (typeof analysis.searchQuery === 'string' ? sanitizeGoogleQueryForDisplay(analysis.searchQuery) : undefined),
    },
  };
}

function buildDiscordStoredFindingRawData({
  existingRawData,
  candidate,
  runContext,
  source,
  scannerConfig,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  classificationSource,
}: {
  existingRawData?: Record<string, unknown>;
  candidate: DiscordServerCandidate;
  runContext: DiscordRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): DiscordStoredFindingRawData {
  const existing = readDiscordStoredFindingRawData(existingRawData);
  return {
    kind: 'discord-normalized',
    version: DISCORD_RAW_DATA_VERSION,
    server: {
      id: candidate.serverId,
      inviteUrl: candidate.inviteUrl,
      vanityUrlCode: candidate.vanityUrlCode,
      name: candidate.name,
      ...(candidate.description ? { description: candidate.description } : {}),
      keywords: uniqueStrings([...(existing?.server.keywords ?? []), ...candidate.keywords]),
      categories: uniqueStrings([...(existing?.server.categories ?? []), ...candidate.categories]),
      primaryCategory: candidate.primaryCategory ?? existing?.server.primaryCategory,
      features: uniqueStrings([...(existing?.server.features ?? []), ...candidate.features]),
      ...(candidate.approximateMemberCount !== undefined ? { approximateMemberCount: candidate.approximateMemberCount } : {}),
      ...(candidate.approximatePresenceCount !== undefined ? { approximatePresenceCount: candidate.approximatePresenceCount } : {}),
      ...(candidate.premiumSubscriptionCount !== undefined ? { premiumSubscriptionCount: candidate.premiumSubscriptionCount } : {}),
      ...(candidate.preferredLocale ? { preferredLocale: candidate.preferredLocale } : {}),
      ...(candidate.isPublished !== undefined ? { isPublished: candidate.isPublished } : {}),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      observedKeywords: uniqueStrings([...(existing?.context.observedKeywords ?? []), ...runContext.observedKeywords]),
      observedCategories: uniqueStrings([...(existing?.context.observedCategories ?? []), ...runContext.observedCategories]),
      observedLocales: uniqueStrings([...(existing?.context.observedLocales ?? []), ...runContext.observedLocales]),
      sampleServerNames: uniqueStrings([...(existing?.context.sampleServerNames ?? []), ...runContext.sampleServerNames]).slice(0, 12),
    },
    analysis: {
      source: classificationSource,
      runId,
      findingSource: source,
      scannerId: scannerConfig.id,
      searchDepth,
      ...(searchQuery ? { searchQuery } : {}),
      ...(displayQuery ? { displayQuery } : {}),
    },
  };
}

function readDiscordStoredFindingRawData(rawData?: Record<string, unknown>): DiscordStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'discord-normalized' || rawData.version !== DISCORD_RAW_DATA_VERSION) {
    return null;
  }

  const server = typeof rawData.server === 'object' && rawData.server !== null ? rawData.server as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'discord-normalized',
    version: DISCORD_RAW_DATA_VERSION,
    server: {
      id: typeof server.id === 'string' ? server.id : '',
      inviteUrl: typeof server.inviteUrl === 'string' ? server.inviteUrl : '',
      vanityUrlCode: typeof server.vanityUrlCode === 'string' ? server.vanityUrlCode : '',
      name: typeof server.name === 'string' ? server.name : '',
      description: typeof server.description === 'string' ? server.description : undefined,
      keywords: Array.isArray(server.keywords)
        ? server.keywords.filter((value): value is string => typeof value === 'string')
        : [],
      categories: Array.isArray(server.categories)
        ? server.categories.filter((value): value is string => typeof value === 'string')
        : [],
      primaryCategory: typeof server.primaryCategory === 'string' ? server.primaryCategory : undefined,
      features: Array.isArray(server.features)
        ? server.features.filter((value): value is string => typeof value === 'string')
        : [],
      approximateMemberCount: typeof server.approximateMemberCount === 'number' ? server.approximateMemberCount : undefined,
      approximatePresenceCount: typeof server.approximatePresenceCount === 'number' ? server.approximatePresenceCount : undefined,
      premiumSubscriptionCount: typeof server.premiumSubscriptionCount === 'number' ? server.premiumSubscriptionCount : undefined,
      preferredLocale: typeof server.preferredLocale === 'string' ? server.preferredLocale : undefined,
      isPublished: typeof server.isPublished === 'boolean' ? server.isPublished : undefined,
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      observedKeywords: Array.isArray(context.observedKeywords)
        ? context.observedKeywords.filter((value): value is string => typeof value === 'string')
        : [],
      observedCategories: Array.isArray(context.observedCategories)
        ? context.observedCategories.filter((value): value is string => typeof value === 'string')
        : [],
      observedLocales: Array.isArray(context.observedLocales)
        ? context.observedLocales.filter((value): value is string => typeof value === 'string')
        : [],
      sampleServerNames: Array.isArray(context.sampleServerNames)
        ? context.sampleServerNames.filter((value): value is string => typeof value === 'string')
        : [],
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'discord',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'discord-servers',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  };
}

function normalizeGoogleSearchSighting(value: unknown): GoogleSearchSighting | null {
  if (typeof value !== 'object' || value === null) return null;
  const sighting = value as Record<string, unknown>;
  if (
    typeof sighting.runId !== 'string' ||
    typeof sighting.searchDepth !== 'number' ||
    typeof sighting.page !== 'number' ||
    typeof sighting.title !== 'string'
  ) {
    return null;
  }

  const searchQuery = typeof sighting.searchQuery === 'string' ? sighting.searchQuery : undefined;
  const displayQuery = typeof sighting.displayQuery === 'string'
    ? sighting.displayQuery
    : (searchQuery ? sanitizeGoogleQueryForDisplay(searchQuery) : undefined);

  return {
    runId: sighting.runId,
    source: isKnownFindingSource(sighting.source) ? sighting.source : 'google',
    scannerId: isKnownGoogleScannerId(sighting.scannerId) ? sighting.scannerId : 'google-web',
    searchDepth: sighting.searchDepth,
    ...(searchQuery ? { searchQuery } : {}),
    ...(displayQuery ? { displayQuery } : {}),
    page: sighting.page,
    position: typeof sighting.position === 'number' ? sighting.position : undefined,
    title: sighting.title,
    displayedUrl: typeof sighting.displayedUrl === 'string' ? sighting.displayedUrl : undefined,
    description: typeof sighting.description === 'string' ? sighting.description : undefined,
    emphasizedKeywords: Array.isArray(sighting.emphasizedKeywords)
      ? sighting.emphasizedKeywords.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
  };
}

function isKnownFindingSource(value: unknown): value is Finding['source'] {
  return (
    value === 'google'
    || value === 'reddit'
    || value === 'tiktok'
    || value === 'youtube'
    || value === 'facebook'
    || value === 'instagram'
    || value === 'discord'
    || value === 'unknown'
  );
}

function isKnownScannerId(value: unknown): value is ActorRunInfo['scannerId'] {
  return (
    value === 'google-web'
    || value === 'google-reddit'
    || value === 'google-tiktok'
    || value === 'google-youtube'
    || value === 'google-facebook'
    || value === 'google-instagram'
    || value === 'discord-servers'
  );
}

function isKnownGoogleScannerId(value: unknown): value is GoogleScannerId {
  return (
    value === 'google-web'
    || value === 'google-reddit'
    || value === 'google-tiktok'
    || value === 'google-youtube'
    || value === 'google-facebook'
    || value === 'google-instagram'
  );
}

function resolveScannerConfig(actorRunInfo?: Partial<ActorRunInfo>): ScannerConfig {
  if (actorRunInfo?.scannerId && isKnownScannerId(actorRunInfo.scannerId)) {
    return getScannerConfigById(actorRunInfo.scannerId);
  }

  if (
    actorRunInfo?.source === 'reddit'
    || actorRunInfo?.source === 'tiktok'
    || actorRunInfo?.source === 'youtube'
    || actorRunInfo?.source === 'facebook'
    || actorRunInfo?.source === 'instagram'
    || actorRunInfo?.source === 'google'
    || actorRunInfo?.source === 'discord'
  ) {
    return getScannerConfigBySource(actorRunInfo.source);
  }

  return getScannerConfigById('google-web');
}

function choosePreferredFindingSource(
  existingSource: Finding['source'] | undefined,
  nextSource: Finding['source'],
): Finding['source'] {
  const rank = (source: Finding['source'] | undefined): number => {
    if (
      source === 'reddit'
      || source === 'tiktok'
      || source === 'youtube'
      || source === 'facebook'
      || source === 'instagram'
      || source === 'discord'
    ) return 3;
    if (source === 'google') return 2;
    if (source === 'unknown') return 1;
    return 0;
  };

  return rank(nextSource) >= rank(existingSource) ? nextSource : (existingSource ?? nextSource);
}

function buildExecutableSearchQuery(
  scannerConfig: ScannerConfig,
  query: string,
): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return '';
  return scannerConfig.kind === 'google'
    ? buildGoogleScannerQuery(scannerConfig.source, trimmedQuery)
    : trimmedQuery;
}

function choosePreferredGoogleOutcome(existing: Finding | null, next: GoogleFindingOutcome): GoogleFindingOutcome {
  if (!existing) return next;

  const existingSource = readGoogleStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: GoogleFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.theme,
    analysis: existing.llmAnalysis,
    isFalsePositive: existing.isFalsePositive === true,
    llmAnalysisPrompt: existing.llmAnalysisPrompt,
    rawLlmResponse: existing.rawLlmResponse,
    classificationSource: existingSource,
  };

  if (existingOutcome.classificationSource !== next.classificationSource) {
    return next.classificationSource === 'llm' ? next : existingOutcome;
  }
  if (existingOutcome.isFalsePositive !== next.isFalsePositive) {
    return existingOutcome.isFalsePositive ? next : existingOutcome;
  }

  const existingRank = getSeverityRank(existingOutcome.severity);
  const nextRank = getSeverityRank(next.severity);
  if (nextRank !== existingRank) {
    return nextRank > existingRank ? next : existingOutcome;
  }

  return next;
}

function choosePreferredDiscordOutcome(existing: Finding | null, next: DiscordFindingOutcome): DiscordFindingOutcome {
  if (!existing) return next;

  const existingSource = readDiscordStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: DiscordFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.theme,
    analysis: existing.llmAnalysis,
    isFalsePositive: existing.isFalsePositive === true,
    llmAnalysisPrompt: existing.llmAnalysisPrompt,
    rawLlmResponse: existing.rawLlmResponse,
    classificationSource: existingSource,
  };

  if (existingOutcome.classificationSource !== next.classificationSource) {
    return next.classificationSource === 'llm' ? next : existingOutcome;
  }
  if (existingOutcome.isFalsePositive !== next.isFalsePositive) {
    return existingOutcome.isFalsePositive ? next : existingOutcome;
  }

  const existingRank = getSeverityRank(existingOutcome.severity);
  const nextRank = getSeverityRank(next.severity);
  if (nextRank !== existingRank) {
    return nextRank > existingRank ? next : existingOutcome;
  }

  return next;
}

function getSeverityRank(severity: Finding['severity']): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function getFindingCountState(finding: Pick<Finding, 'severity' | 'isFalsePositive'>) {
  if (finding.isFalsePositive) {
    return { findingCount: 0, counts: { high: 0, medium: 0, low: 0, nonHit: 1 } };
  }

  return {
    findingCount: 1,
    counts: {
      high: finding.severity === 'high' ? 1 : 0,
      medium: finding.severity === 'medium' ? 1 : 0,
      low: finding.severity === 'low' ? 1 : 0,
      nonHit: 0,
    },
  };
}

function getOutcomeCountState(outcome: Pick<Finding, 'severity'> & { isFalsePositive: boolean }) {
  return getFindingCountState({
    severity: outcome.severity,
    isFalsePositive: outcome.isFalsePositive,
  });
}

function emptyFindingCountState(): FindingDelta {
  return { findingCount: 0, counts: { high: 0, medium: 0, low: 0, nonHit: 0 } };
}

function diffFindingStates(previous: FindingDelta, next: FindingDelta): FindingDelta {
  return {
    findingCount: next.findingCount - previous.findingCount,
    counts: {
      high: next.counts.high - previous.counts.high,
      medium: next.counts.medium - previous.counts.medium,
      low: next.counts.low - previous.counts.low,
      nonHit: next.counts.nonHit - previous.counts.nonHit,
    },
  };
}

function buildScanFindingTotals(findings: Iterable<Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'>>): ScanFindingTotals {
  const totals: ScanFindingTotals = {
    findingCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    nonHitCount: 0,
    ignoredCount: 0,
    addressedCount: 0,
    skippedCount: 0,
  };

  for (const finding of findings) {
    if (finding.isFalsePositive) {
      totals.nonHitCount++;
      continue;
    }

    totals.findingCount++;

    if (finding.isIgnored) {
      totals.ignoredCount++;
      continue;
    }

    if (finding.isAddressed) {
      totals.addressedCount++;
      continue;
    }

    if (finding.severity === 'high') totals.highCount++;
    else if (finding.severity === 'medium') totals.mediumCount++;
    else totals.lowCount++;
  }

  return totals;
}

function getNextScanFindingTotals(
  scan: Scan,
  newFindingCount: number,
  newCounts: { high: number; medium: number; low: number; nonHit: number },
  newSkippedCount: number,
): ScanFindingTotals {
  return {
    findingCount: (scan.findingCount ?? 0) + newFindingCount,
    highCount: (scan.highCount ?? 0) + newCounts.high,
    mediumCount: (scan.mediumCount ?? 0) + newCounts.medium,
    lowCount: (scan.lowCount ?? 0) + newCounts.low,
    nonHitCount: (scan.nonHitCount ?? 0) + newCounts.nonHit,
    ignoredCount: scan.ignoredCount ?? 0,
    addressedCount: scan.addressedCount ?? 0,
    skippedCount: (scan.skippedCount ?? 0) + newSkippedCount,
  };
}

function hasPersistedScanResults(totals: ScanFindingTotals): boolean {
  return totals.findingCount > 0 || totals.nonHitCount > 0 || totals.skippedCount > 0;
}

function getSkippedDuplicateCount(actorRuns?: Record<string, ActorRunInfo>): number {
  if (!actorRuns) return 0;
  return Object.values(actorRuns).reduce((sum, run) => sum + (run.skippedDuplicateCount ?? 0), 0);
}

function formatScanSeverityBreakdown(counts: { high: number; medium: number; low: number }): string {
  const parts: string[] = [];
  if (counts.high > 0) parts.push(`${counts.high} high`);
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(`${counts.low} low`);

  if (parts.length === 0) return 'no actionable findings';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} and ${parts[2]}`;
}

function buildFallbackScanAiSummary(findings: ScanSummaryFindingInput[]): string {
  const counts = findings.reduce(
    (acc, finding) => {
      if (finding.severity === 'high') acc.high++;
      else if (finding.severity === 'medium') acc.medium++;
      else acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const total = findings.length;
  const sentences = [
    `This scan surfaced ${total} actionable finding${total === 1 ? '' : 's'}: ${formatScanSeverityBreakdown(counts)}.`,
  ];

  if (counts.high > 0) {
    sentences.push('The highest-risk items suggest potentially damaging brand misuse and should be prioritised for review.');
  } else if (counts.medium > 0) {
    sentences.push('The main concerns are suspicious associations that warrant manual review even though the evidence is less definitive.');
  } else {
    sentences.push('The findings appear lower-risk overall, but they still indicate ongoing third-party use of the brand that is worth monitoring.');
  }

  if (counts.high + counts.medium >= 2) {
    sentences.push('The pattern does not appear isolated, which may point to broader or repeated misuse themes rather than a single one-off mention.');
  }

  return sentences.join(' ');
}

function truncateSummaryInput(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sortFindingsForSummary(findings: ScanSummaryFindingInput[]): ScanSummaryFindingInput[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...findings].sort((left, right) => {
    const severityDiff = rank[left.severity] - rank[right.severity];
    if (severityDiff !== 0) return severityDiff;
    return left.title.localeCompare(right.title);
  });
}

async function buildScanAiSummary(scan: Scan): Promise<string> {
  const findingsSnap = await db
    .collection('findings')
    .where('scanId', '==', scan.id)
    .where('brandId', '==', scan.brandId)
    .where('userId', '==', scan.userId)
    .select('severity', 'title', 'llmAnalysis', 'source', 'url', 'isFalsePositive')
    .get();

  const findings = sortFindingsForSummary(
    findingsSnap.docs
      .map((doc) => doc.data() as ScanSummaryFindingInput & { isFalsePositive?: boolean })
      .filter((finding) => finding.isFalsePositive !== true)
      .map((finding) => ({
        severity: finding.severity,
        title: finding.title,
        llmAnalysis: finding.llmAnalysis,
        source: finding.source,
        url: finding.url,
      })),
  );

  if (findings.length === 0) {
    return buildCountOnlyScanAiSummary(scan);
  }

  const brandDoc = await db.collection('brands').doc(scan.brandId).get();
  const brandName = brandDoc.exists ? (brandDoc.data() as BrandProfile).name : 'Unknown brand';
  const counts = findings.reduce(
    (acc, finding) => {
      if (finding.severity === 'high') acc.high++;
      else if (finding.severity === 'medium') acc.medium++;
      else acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const prompt = buildScanSummaryPrompt({
    brandName,
    counts,
    findings: findings.map((finding) => ({
      severity: finding.severity,
      source: finding.source,
      title: truncateSummaryInput(finding.title, 120),
      llmAnalysis: truncateSummaryInput(finding.llmAnalysis, 320),
      ...(finding.url ? { url: truncateSummaryInput(finding.url, 200) } : {}),
    })),
  });

  try {
    const raw = await chatCompletion([
      { role: 'system', content: SCAN_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ]);

    const parsed = parseScanSummaryOutput(raw);
    if (!parsed) {
      throw new Error(`Failed to parse scan summary output: ${raw.slice(0, 200)}`);
    }

    return parsed.summary;
  } catch (err) {
    console.error(`[webhook] Scan summary generation failed for scan ${scan.id}:`, err);
    return buildFallbackScanAiSummary(findings);
  }
}

async function finalizeScanWithSummary(scanRef: DocumentReference, summary: string) {
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanRef);
    if (!freshSnap.exists) return;

    const fresh = scanFromSnapshot(freshSnap);
    if (fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'failed') {
      return;
    }
    if (fresh.status !== 'summarising') {
      return;
    }

    const brandRef = db.collection('brands').doc(fresh.brandId);
    const brandSnap = await tx.get(brandRef);
    const brand = brandSnap.exists ? (brandSnap.data() as BrandProfile) : undefined;

    tx.update(scanRef, {
      status: 'completed',
      aiSummary: summary,
      completedAt: FieldValue.serverTimestamp(),
      summaryStartedAt: FieldValue.delete(),
      ...(fresh.errorMessage ? { errorMessage: FieldValue.delete() } : {}),
    });

    await clearBrandActiveScanIfMatches(brandRef, fresh.id, tx, brand);
  });
}

async function generateAndPersistScanSummary(scanRef: DocumentReference) {
  const freshSnap = await scanRef.get();
  if (!freshSnap.exists) return;

  const fresh = scanFromSnapshot(freshSnap);
  if (fresh.status !== 'summarising') return;

  let summary: string;
  try {
    summary = await buildScanAiSummary(fresh);
  } catch (err) {
    console.error(`[webhook] Unexpected scan summary build error for scan ${fresh.id}:`, err);
    summary = buildCountOnlyScanAiSummary(fresh);
  }

  await finalizeScanWithSummary(scanRef, summary);
  await sendCompletedScanSummaryEmailIfNeeded(scanRef);
}

function normalizeSuggestedSearchKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildGoogleFindingId(scanId: string, normalizedUrl: string): string {
  return `${GOOGLE_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${normalizedUrl}`).digest('hex')}`;
}

function buildDiscordFindingId(scanId: string, serverId: string): string {
  return `${DISCORD_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${serverId}`).digest('hex')}`;
}

function normalizeUrlForFinding(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }

    const keptParams = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_QUERY_PARAM_NAMES.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
      );

    parsed.search = '';
    for (const [key, value] of keptParams) {
      parsed.searchParams.append(key, value);
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    const normalized = parsed.toString().replace(/\/$/, '');
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function readGooglePageNumber(item: Record<string, unknown>): number {
  const searchQuery = typeof item.searchQuery === 'object' && item.searchQuery !== null
    ? item.searchQuery as Record<string, unknown>
    : null;
  const page = searchQuery?.page;
  if (typeof page === 'number' && Number.isFinite(page)) return page;
  if (typeof page === 'string' && /^\d+$/.test(page)) return Number(page);
  return 1;
}

function readGoogleSourceQuery(item: Record<string, unknown>): string | undefined {
  if (typeof item.query === 'string' && item.query.trim().length > 0) return item.query.trim();
  if (typeof item.searchQuery === 'object' && item.searchQuery !== null) {
    const term = (item.searchQuery as Record<string, unknown>).term;
    if (typeof term === 'string' && term.trim().length > 0) return term.trim();
  }
  return undefined;
}

function readGoogleTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const title = entry.title;
      return typeof title === 'string' ? title.trim() : '';
    })
    .filter((title) => title.length > 0);
}

function readDiscordServerId(item: Record<string, unknown>): string | null {
  const candidateIds = [item.id, item.objectID];
  for (const value of candidateIds) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readDiscordSourceQueries(value?: string): string[] {
  if (!value) return [];
  return uniqueStrings(
    value
      .split('|')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function readDiscordServerName(item: Record<string, unknown>): string | undefined {
  return readOptionalTrimmedString(item.name) ?? readOptionalTrimmedString(item.title);
}

function readDiscordVanityUrlCode(item: Record<string, unknown>): string | null {
  const value = readOptionalTrimmedString(item.vanity_url_code);
  return value && value.length > 0 ? value : null;
}

function buildDiscordInviteUrl(vanityUrlCode: string): string | null {
  const normalized = vanityUrlCode.trim();
  if (!normalized) return null;
  return `https://discord.gg/${encodeURIComponent(normalized)}`;
}

function readDiscordCategoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => readOptionalTrimmedString(entry.name) ?? '')
      .filter((entry) => entry.length > 0),
  );
}

function readDiscordPrimaryCategory(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return readOptionalTrimmedString((value as Record<string, unknown>).name);
}

function readDiscordStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim()),
  );
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function mergeGoogleSightings(
  existingSightings: GoogleSearchSighting[] | undefined,
  newSightings: GoogleSearchSighting[],
): GoogleSearchSighting[] {
  const merged = new Map<string, GoogleSearchSighting>();
  for (const sighting of [...(existingSightings ?? []), ...newSightings]) {
    const key = `${sighting.runId}:${sighting.page}:${sighting.position ?? 'na'}`;
    if (!merged.has(key)) {
      merged.set(key, sighting);
    }
  }
  return Array.from(merged.values()).sort((left, right) =>
    left.page === right.page
      ? (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
      : left.page - right.page,
  );
}

function uniqueSortedNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];

  const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= values.length) return;
      results[currentIndex] = await worker(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

/**
 * Use a Firestore transaction to atomically mark an actor run as complete,
 * increment completedRunCount, update findingCount, and — if all runs are
 * now done — set the overall scan status to 'completed' or 'failed'.
 *
 * IMPORTANT: totalRunCount is read from the fresh snapshot inside the transaction
 * so that dynamically-added deep-search runs are correctly accounted for.
 */
async function markActorRunComplete(
  scanDoc: ScanDocHandle,
  runId: string,
  runStatus: 'succeeded' | 'failed',
  newFindingCount = 0,
  newCounts: { high: number; medium: number; low: number; nonHit: number } = { high: 0, medium: 0, low: 0, nonHit: 0 },
  newSkippedCount = 0,
  options: MarkActorRunCompleteOptions = {},
) {
  const result = await db.runTransaction<MarkActorRunCompleteResult>(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    const fresh = freshSnap.data() as Scan;

    // If the scan was cancelled (e.g. user cancelled while this run was being processed),
    // do not overwrite the cancelled status or increment completion counters.
    if (fresh.status === 'cancelled') {
      console.log(`[webhook] markActorRunComplete: scan ${scanDoc.id} is cancelled — skipping`);
      return { needsSummary: false };
    }

    const existingRunStatus = fresh.actorRuns?.[runId]?.status;
    if (existingRunStatus === 'succeeded' || existingRunStatus === 'failed') {
      console.log(`[webhook] markActorRunComplete: run ${runId} already ${existingRunStatus} — skipping duplicate completion`);
      return { needsSummary: false };
    }

    // Read the current total from the fresh snapshot so any deep-search runs
    // added after the scan started are included in the completion check.
    const totalRunCount = fresh.actorRunIds?.length ?? 1;
    const updatedCompletedCount = (fresh.completedRunCount ?? 0) + 1;
    const allDone = updatedCompletedCount >= totalRunCount;
    const reconciledTotals = options.reconcilePersistedCounts
      ? {
        ...buildScanFindingTotals(
        (
          await tx.get(
            db
              .collection('findings')
              .where('scanId', '==', scanDoc.id)
              .where('brandId', '==', fresh.brandId)
              .where('userId', '==', fresh.userId)
              .select('severity', 'isFalsePositive', 'isIgnored', 'isAddressed'),
          )
        ).docs.map((doc) => doc.data() as Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored' | 'isAddressed'>),
        ),
        skippedCount: getSkippedDuplicateCount(fresh.actorRuns),
      }
      : null;
    const nextTotals = reconciledTotals ?? getNextScanFindingTotals(fresh, newFindingCount, newCounts, newSkippedCount);

    const updates: Record<string, unknown> = {
      [`actorRuns.${runId}.status`]: runStatus,
      completedRunCount: FieldValue.increment(1),
      ...(reconciledTotals
        ? {
          findingCount: reconciledTotals.findingCount,
          highCount: reconciledTotals.highCount,
          mediumCount: reconciledTotals.mediumCount,
          lowCount: reconciledTotals.lowCount,
          nonHitCount: reconciledTotals.nonHitCount,
          ignoredCount: reconciledTotals.ignoredCount,
          addressedCount: reconciledTotals.addressedCount,
          skippedCount: reconciledTotals.skippedCount,
        }
        : {
          findingCount: FieldValue.increment(newFindingCount),
          highCount: FieldValue.increment(newCounts.high),
          mediumCount: FieldValue.increment(newCounts.medium),
          lowCount: FieldValue.increment(newCounts.low),
          nonHitCount: FieldValue.increment(newCounts.nonHit),
          skippedCount: FieldValue.increment(newSkippedCount),
        }),
    };

    if (allDone) {
      // Determine overall scan outcome: completed if at least one actor succeeded
      const actorRuns = fresh.actorRuns ?? {};
      const anySucceeded =
        runStatus === 'succeeded' ||
        Object.values(actorRuns).some((r) => r.status === 'succeeded');
      const hasResults = hasPersistedScanResults(nextTotals);

      if (anySucceeded || hasResults) {
        updates.status = 'summarising';
        updates.summaryStartedAt = FieldValue.serverTimestamp();
      } else {
        updates.status = 'failed';
        updates.completedAt = FieldValue.serverTimestamp();
        updates.errorMessage = 'All actor runs failed or were aborted';
        await clearBrandActiveScanIfMatches(db.collection('brands').doc(fresh.brandId), scanDoc.id, tx);
      }

      if (updates.status === 'summarising') {
        console.log(`[webhook] Scan ${scanDoc.id} finished actor processing — generating summary`);
      } else {
        console.log(`[webhook] Scan ${scanDoc.id} is complete — status: ${updates.status}`);
      }

      if (!anySucceeded && hasResults) {
        console.warn(`[webhook] Scan ${scanDoc.id} completed after a processing error because persisted results were already available`);
      }
    }

    tx.update(scanDoc.ref, updates);
    return { needsSummary: allDone && updates.status === 'summarising' };
  });

  if (result.needsSummary) {
    await generateAndPersistScanSummary(scanDoc.ref);
  }
}

