import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type DocumentReference, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { fetchDatasetItems, startDeepSearchRun } from '@/lib/apify/client';
import { getActorConfig } from '@/lib/apify/actors';
import { chatCompletion } from '@/lib/analysis/openrouter';
import {
  SYSTEM_PROMPT,
  GOOGLE_CLASSIFICATION_SYSTEM_PROMPT,
  SCAN_SUMMARY_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildGoogleFinalSelectionSystemPrompt,
  buildGoogleFinalSelectionPrompt,
  buildGoogleChunkAnalysisPrompt,
  buildScanSummaryPrompt,
} from '@/lib/analysis/prompts';
import {
  parseAnalysisOutput,
  parseGoogleChunkAnalysisOutput,
  parseGoogleSuggestionOutput,
  parseScanSummaryOutput,
  type GoogleChunkAnalysisItem,
  type GoogleRunContext,
  type GoogleSearchCandidate,
  type GoogleSearchSighting,
  type GoogleStoredFindingRawData,
} from '@/lib/analysis/types';
import type { BrandProfile, Finding, Scan, ActorRunInfo } from '@/lib/types';
import { normalizeAllowAiDeepSearches, normalizeMaxAiDeepSearches } from '@/lib/brands';
import { sendCompletedScanSummaryEmailIfNeeded } from '@/lib/scan-summary-emails';
import { buildCountOnlyScanAiSummary, clearBrandActiveScanIfMatches, scanFromSnapshot } from '@/lib/scans';

/** Maximum items to analyse per actor run — caps AI analysis cost and latency */
const MAX_ITEMS_PER_RUN = 50;
const GOOGLE_ANALYSIS_CHUNK_SIZE = 10;
const GOOGLE_ANALYSIS_CONCURRENCY = 3;
const MAX_GOOGLE_CONTEXT_SOURCE_QUERIES = 5;
const GOOGLE_FINDING_ID_PREFIX = 'google';
const GOOGLE_RAW_DATA_VERSION = 1;
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
    const claim = await claimSucceededRunForProcessing(scanDoc, resource.id);
    if (claim.kind === 'cancelled') {
      console.log(`[webhook] Ignoring callback for run ${resource.id} — scan ${scanDoc.id} is cancelled`);
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
  | { kind: 'cancelled' }
  | { kind: 'already_terminal'; status: 'succeeded' | 'failed' }
  | { kind: 'already_processing'; status: 'fetching_dataset' | 'analysing' }
  | { kind: 'missing' };

/**
 * Claim a successful webhook callback before any dataset fetch / AI analysis begins.
 *
 * This transaction closes the race where duplicate Apify callbacks arrive close
 * together: only the winner is allowed to transition the run into
 * `fetching_dataset`, and any concurrent loser exits before doing expensive work.
 */
async function claimSucceededRunForProcessing(
  scanDoc: QueryDocumentSnapshot,
  runId: string,
): Promise<SucceededRunClaimResult> {
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    if (!freshSnap.exists) return { kind: 'missing' };

    const fresh = freshSnap.data() as Scan;
    if (fresh.status === 'cancelled') return { kind: 'cancelled' };

    const run = fresh.actorRuns?.[runId];
    if (!run) return { kind: 'missing' };

    if (run.status === 'succeeded' || run.status === 'failed') {
      return { kind: 'already_terminal', status: run.status };
    }

    if (run.status === 'fetching_dataset' || run.status === 'analysing') {
      return { kind: 'already_processing', status: run.status };
    }

    tx.update(scanDoc.ref, {
      [`actorRuns.${runId}.status`]: 'fetching_dataset',
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
  scanDoc: QueryDocumentSnapshot;
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
  const source = actorRunInfo?.source ?? 'unknown';
  const actorId = actorRunInfo?.actorId ?? 'unknown';
  const searchDepth = actorRunInfo?.searchDepth ?? 0;
  const searchQuery = actorRunInfo?.searchQuery;
  const maxSuggestedSearches = normalizeMaxAiDeepSearches(brand.maxAiDeepSearches);
  const actorConfig = getActorConfig(actorId);
  const analysisMode = actorConfig?.analysisMode ?? 'per-item';
  const shouldSkipPreviouslySeenUrls =
    analysisMode === 'batch' || source === 'google' || actorId === 'apify/google-search-scraper';

  // Fetch all URLs that the user has previously ignored for this brand so that
  // AI analysis can skip them rather than re-reporting them on every scan.
  const ignoredSnap = await db
    .collection('findings')
    .where('brandId', '==', scan.brandId)
    .where('userId', '==', scan.userId)
    .where('isIgnored', '==', true)
    .select('url')
    .get();
  const ignoredUrls = ignoredSnap.docs
    .map((d) => (d.data() as { url?: string }).url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  const previousFindingUrls = shouldSkipPreviouslySeenUrls
    ? await loadPreviousFindingUrls({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : new Set<string>();

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

  if (analysisMode === 'batch') {
    // Send all SERP pages to AI analysis in one call → one Finding per individual search result
    const { findingCount, suggestedSearches, counts: batchCounts, skippedDuplicateCount: batchSkippedDuplicateCount } = await analyseAndWriteBatch({
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
      ignoredUrls,
      previousFindingUrls,
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
        maxSuggestedSearches,
      });
      if (reservedQueries.length > 0) {
        await triggerDeepSearches({
          scanDoc,
          scan,
          suggestedSearches: reservedQueries,
          maxSuggestedSearches,
          webhookUrl,
          source,
          actorId: 'apify/google-search-scraper',
        });
      }
    }
  } else {
    // Analyse each item sequentially to avoid rate-limiting OpenRouter
    for (const item of itemsToAnalyse) {
      try {
        const analysisResult = await analyseItem({ brand, source, actorId, item, ignoredUrls });
        const findingRef = db.collection('findings').doc();
        const finding: Omit<Finding, 'id'> = {
          scanId: scan.id ?? scanDoc.id,
          brandId: scan.brandId,
          userId: scan.userId,
          source,
          actorId,
          severity: analysisResult.severity,
          title: analysisResult.title,
          description: analysisResult.llmAnalysis,
          llmAnalysis: analysisResult.llmAnalysis,
          url: extractUrl(item),
          rawData: item,
          isFalsePositive: analysisResult.isFalsePositive,
          // Auto-ignore AI-classified false positives so their URLs are excluded
          // from future scans. Users can un-ignore them if needed.
          ...(analysisResult.isFalsePositive && {
            isIgnored: true,
            ignoredAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
          }),
          rawLlmResponse: analysisResult.rawLlmResponse,
          createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        };
        await findingRef.set(finding);
        if (analysisResult.isFalsePositive) {
          counts.nonHit++;
        } else {
          newFindingCount++;
          if (analysisResult.severity === 'high') counts.high++;
          else if (analysisResult.severity === 'medium') counts.medium++;
          else if (analysisResult.severity === 'low') counts.low++;
        }
      } catch (err) {
        // On AI analysis failure, write a fallback finding so no data is silently lost
        console.error(`[webhook] AI analysis failed for item in dataset ${datasetId}:`, err);
        const findingRef = db.collection('findings').doc();
        const fallbackFinding: Omit<Finding, 'id'> = {
          scanId: scan.id ?? scanDoc.id,
          brandId: scan.brandId,
          userId: scan.userId,
          source,
          actorId,
          severity: 'medium',
          title: 'Unanalysed result — review manually',
          description: 'AI analysis failed for this item. Raw data is preserved for manual review.',
          llmAnalysis: 'AI analysis failed for this item. Raw data is preserved for manual review.',
          url: extractUrl(item),
          rawData: item,
          isFalsePositive: false,
          createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        };
        await findingRef.set(fallbackFinding);
        newFindingCount++;
        counts.medium++;
      }

      // Update per-item progress counter so the UI can show "X / N analysed"
      await scanDoc.ref.update({
        [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(1),
      });
    }
  }

  console.log(
    `[webhook] Actor ${actorId} (run ${runId}, depth ${searchDepth}): ${newFindingCount} findings written from ${itemsToAnalyse.length} items, ${skippedDuplicateCount} skipped as previous duplicates (mode: ${analysisMode})`,
  );

  await markActorRunComplete(scanDoc, runId, 'succeeded', newFindingCount, counts, skippedDuplicateCount);
}

async function recoverFromSucceededRunError({
  scanDoc,
  runId,
  err,
}: {
  scanDoc: QueryDocumentSnapshot;
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

/**
 * Batch mode: send all SERP pages to AI analysis in one call, then write one Finding
 * per individual search result assessed. Returns the count of non-false-positive
 * findings and any suggested follow-up search queries.
 */
async function analyseAndWriteBatch({
  scanDoc,
  scan,
  brand,
  source,
  actorId,
  datasetId,
  runId,
  items,
  searchDepth,
  searchQuery,
  ignoredUrls,
  previousFindingUrls,
}: {
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  ignoredUrls?: string[];
  previousFindingUrls?: ReadonlySet<string>;
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
    runId,
    searchDepth,
    searchQuery,
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
      try {
        const chunkResult = await analyseGoogleChunk({
          brand,
          source,
          candidates: chunk,
          runContext: normalizedRun.runContext,
          ignoredUrls,
        });

        return chunkResult;
      } catch (err) {
        console.error(`[webhook] Google chunk analysis failed for dataset ${datasetId} (chunk ${chunkIndex + 1}/${chunks.length}):`, err);

        const fallbackOutcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();
        for (const candidate of chunk) {
          fallbackOutcomes.set(candidate.normalizedUrl, {
            candidate,
            outcome: buildGoogleFallbackOutcome('AI analysis failed for this chunk. Raw data is preserved for manual review.'),
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
      candidate,
      runContext: normalizedRun.runContext,
      outcome,
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
  analysis: string;
  isFalsePositive: boolean;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type GoogleChunkAnalysisResult = {
  outcomes: Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>;
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
  runId,
  searchDepth,
  searchQuery,
  items,
}: {
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: GoogleSearchCandidate[]; runContext: GoogleRunContext } {
  const candidateMap = new Map<string, GoogleSearchCandidate>();
  const relatedQueries = new Set<string>();
  const peopleAlsoAsk = new Set<string>();
  const sourceQueries = new Set<string>();
  let nextResultId = 1;

  for (const item of items) {
    const pageNumber = readGooglePageNumber(item);
    const sourceQuery = searchQuery ?? readGoogleSourceQuery(item);
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
        searchDepth,
        page: pageNumber,
        title,
        ...(sourceQuery ? { searchQuery: sourceQuery } : {}),
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

async function analyseGoogleChunk({
  brand,
  source,
  candidates,
  runContext,
  ignoredUrls,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  candidates: GoogleSearchCandidate[];
  runContext: GoogleRunContext;
  ignoredUrls?: string[];
}): Promise<GoogleChunkAnalysisResult> {
  const prompt = buildGoogleChunkAnalysisPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    ignoredUrls,
    source,
    candidates,
    runContext,
  });

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
        ? buildGoogleFindingOutcome(item, raw)
        : buildGoogleFallbackOutcome('AI analysis returned no assessment for this result. Raw data is preserved for manual review.', raw),
    });
  }

  return { outcomes };
}

async function analyseGoogleFinalSelection({
  brand,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildGoogleFinalSelectionPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildGoogleFinalSelectionSystemPrompt(maxSuggestedSearches);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseGoogleSuggestionOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse Google final selection output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
}

async function finalizeSuggestedSearches({
  brand,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  runContext: GoogleRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseGoogleFinalSelection({
      brand,
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

async function upsertGoogleFinding({
  scanDoc,
  scan,
  source,
  actorId,
  runId,
  searchDepth,
  searchQuery,
  candidate,
  runContext,
  outcome,
}: {
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
  source: Finding['source'];
  actorId: string;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
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
      runId,
      searchDepth,
      searchQuery,
      classificationSource: preferredOutcome.classificationSource,
    });

    const previousState = existing ? getFindingCountState(existing) : emptyFindingCountState();
    const nextState = getOutcomeCountState(preferredOutcome);

    if (!existing) {
      const finding: Omit<Finding, 'id'> = {
        scanId,
        brandId: scan.brandId,
        userId: scan.userId,
        source,
        actorId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.normalizedUrl,
        rawData: mergedRawData,
        isFalsePositive: preferredOutcome.isFalsePositive,
        ...(preferredOutcome.isFalsePositive && {
          isIgnored: true,
          ignoredAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
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
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.normalizedUrl,
      rawData: mergedRawData,
      isFalsePositive: preferredOutcome.isFalsePositive,
    };

    const rawLlmResponse = preferredOutcome.rawLlmResponse ?? existing.rawLlmResponse;
    if (typeof rawLlmResponse === 'string') {
      updates.rawLlmResponse = rawLlmResponse;
    }

    if (preferredOutcome.isFalsePositive) {
      updates.isIgnored = true;
      if (existing.isIgnored !== true) {
        updates.ignoredAt = FieldValue.serverTimestamp();
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
  maxSuggestedSearches,
}: {
  scanDoc: QueryDocumentSnapshot;
  runId: string;
  suggestedSearches: string[];
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
        .map((value) => value.searchQuery?.trim().toLowerCase())
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    const reserved = uniqueStrings(suggestedSearches)
      .filter((query) => !existingQueries.has(query.toLowerCase()))
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
  suggestedSearches,
  maxSuggestedSearches,
  webhookUrl,
  source,
  actorId,
}: {
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
  suggestedSearches: string[];
  maxSuggestedSearches: number;
  webhookUrl: string;
  source: Finding['source'];
  actorId: string;
}) {
  const queries = suggestedSearches.slice(0, maxSuggestedSearches);

  const newRunIds: string[] = [];
  const newActorRuns: Record<string, ActorRunInfo> = {};

  for (const query of queries) {
    try {
      const { runId } = await startDeepSearchRun(query, webhookUrl);
      newRunIds.push(runId);
      newActorRuns[runId] = {
        actorId,
        source,
        status: 'running',
        skippedDuplicateCount: 0,
        searchDepth: 1,
        searchQuery: query,
      };
    } catch (err) {
      console.error(`[webhook] Failed to start deep search for "${query}":`, err);
    }
  }

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

/**
 * Run a single dataset item through AI analysis for classification.
 * Returns parsed fields plus the raw AI response string for storage / debugging.
 */
async function analyseItem({
  brand,
  source,
  actorId,
  item,
  ignoredUrls,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  actorId: string;
  item: Record<string, unknown>;
  ignoredUrls?: string[];
}): Promise<{ severity: Finding['severity']; title: string; llmAnalysis: string; isFalsePositive: boolean; rawLlmResponse: string }> {
  void actorId;
  const prompt = buildAnalysisPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    ignoredUrls,
    source,
    rawData: item,
  });

  const raw = await chatCompletion([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseAnalysisOutput(raw);
  if (!parsed) {
    throw new Error(`Failed to parse AI analysis output: ${raw.slice(0, 200)}`);
  }

  return { ...parsed, rawLlmResponse: raw };
}

function buildGoogleFindingOutcome(item: GoogleChunkAnalysisItem, rawLlmResponse: string): GoogleFindingOutcome {
  return {
    severity: item.severity,
    title: item.title,
    analysis: item.analysis,
    isFalsePositive: item.isFalsePositive,
    rawLlmResponse,
    classificationSource: 'llm',
  };
}

function buildGoogleFallbackOutcome(message: string, rawLlmResponse?: string): GoogleFindingOutcome {
  return {
    severity: 'medium',
    title: 'Unanalysed result — review manually',
    analysis: message,
    isFalsePositive: false,
    rawLlmResponse,
    classificationSource: 'fallback',
  };
}

function buildGoogleStoredFindingRawData({
  existingRawData,
  candidate,
  runContext,
  runId,
  searchDepth,
  searchQuery,
  classificationSource,
}: {
  existingRawData?: Record<string, unknown>;
  candidate: GoogleSearchCandidate;
  runContext: GoogleRunContext;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
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
      searchDepth,
      ...(searchQuery ? { searchQuery } : {}),
    },
  };
}

function readGoogleStoredFindingRawData(rawData?: Record<string, unknown>): GoogleStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'google-normalized' || rawData.version !== GOOGLE_RAW_DATA_VERSION) {
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
      ? rawData.sightings.filter((value): value is GoogleSearchSighting => isGoogleSearchSighting(value))
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
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
    },
  };
}

function isGoogleSearchSighting(value: unknown): value is GoogleSearchSighting {
  if (typeof value !== 'object' || value === null) return false;
  const sighting = value as Record<string, unknown>;
  return (
    typeof sighting.runId === 'string' &&
    typeof sighting.searchDepth === 'number' &&
    typeof sighting.page === 'number' &&
    typeof sighting.title === 'string'
  );
}

function choosePreferredGoogleOutcome(existing: Finding | null, next: GoogleFindingOutcome): GoogleFindingOutcome {
  if (!existing) return next;

  const existingSource = readGoogleStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: GoogleFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    analysis: existing.llmAnalysis,
    isFalsePositive: existing.isFalsePositive === true,
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

function getOutcomeCountState(outcome: Pick<GoogleFindingOutcome, 'severity' | 'isFalsePositive'>) {
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

function buildScanFindingTotals(findings: Iterable<Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored'>>): ScanFindingTotals {
  const totals: ScanFindingTotals = {
    findingCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    nonHitCount: 0,
    ignoredCount: 0,
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
  scanDoc: QueryDocumentSnapshot,
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
              .select('severity', 'isFalsePositive', 'isIgnored'),
          )
        ).docs.map((doc) => doc.data() as Pick<Finding, 'severity' | 'isFalsePositive' | 'isIgnored'>),
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

/**
 * Best-effort extraction of a URL from a dataset item.
 * Different actors use different field names for the source URL.
 */
function extractUrl(item: Record<string, unknown>): string | undefined {
  const candidates = ['url', 'link', 'pageUrl', 'profileUrl', 'appUrl', 'storeUrl'];
  for (const key of candidates) {
    const val = item[key];
    if (typeof val === 'string' && val.startsWith('http')) {
      return val;
    }
  }
  return undefined;
}
