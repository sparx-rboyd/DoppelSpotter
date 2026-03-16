import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type DocumentReference, type Transaction } from '@google-cloud/firestore';
import { buildDeepSearchPreparedInput, fetchDatasetItems } from '@/lib/apify/client';
import { chatCompletion } from '@/lib/analysis/openrouter';
import {
  buildQueuedActorRunInfo,
  hasQueuedActorLaunchWork,
  isActorRunInFlight,
} from '@/lib/apify/live-run-cap';
import { drainQueuedActorRunsIfCapacity } from '@/lib/apify/launch-queue';
import { resolveBrandAnalysisSeverityDefinitions } from '@/lib/analysis-severity';
import { normalizeAndPersistScanThemes } from '@/lib/analysis/theme-normalization';
import { areUserPreferenceHintsTerminal } from '@/lib/analysis/user-preference-hints';
import {
  DISCORD_CLASSIFICATION_SYSTEM_PROMPT,
  DOMAIN_REGISTRATION_CLASSIFICATION_SYSTEM_PROMPT,
  EUIPO_CLASSIFICATION_SYSTEM_PROMPT,
  GITHUB_CLASSIFICATION_SYSTEM_PROMPT,
  GOOGLE_CLASSIFICATION_SYSTEM_PROMPT,
  REDDIT_CLASSIFICATION_SYSTEM_PROMPT,
  TIKTOK_CLASSIFICATION_SYSTEM_PROMPT,
  X_CLASSIFICATION_SYSTEM_PROMPT,
  buildRedditChunkAnalysisPrompt,
  buildTikTokChunkAnalysisPrompt,
  buildDiscordChunkAnalysisPrompt,
  buildDomainRegistrationChunkAnalysisPrompt,
  buildEuipoChunkAnalysisPrompt,
  buildGitHubChunkAnalysisPrompt,
  buildGoogleFinalSelectionSystemPrompt,
  buildGoogleFinalSelectionPrompt,
  buildGoogleChunkAnalysisPrompt,
  buildRedditFinalSelectionPrompt,
  buildRedditFinalSelectionSystemPrompt,
  buildTikTokFinalSelectionPrompt,
  buildTikTokFinalSelectionSystemPrompt,
  buildXChunkAnalysisPrompt,
  buildXFinalSelectionPrompt,
  buildXFinalSelectionSystemPrompt,
  formatLlmPromptForDebug,
} from '@/lib/analysis/prompts';
import {
  parseRedditChunkAnalysisOutput,
  parseTikTokChunkAnalysisOutput,
  parseDiscordChunkAnalysisOutput,
  parseDomainRegistrationChunkAnalysisOutput,
  parseEuipoChunkAnalysisOutput,
  parseGitHubChunkAnalysisOutput,
  parseGoogleChunkAnalysisOutput,
  parseXChunkAnalysisOutput,
  parseSuggestedSearchOutput,
  type DiscordChunkAnalysisItem,
  type DiscordRunContext,
  type DiscordServerCandidate,
  type DiscordStoredFindingRawData,
  type DomainRegistrationCandidate,
  type DomainRegistrationChunkAnalysisItem,
  type DomainRegistrationRunContext,
  type DomainRegistrationStoredFindingRawData,
  type EuipoChunkAnalysisItem,
  type EuipoRunContext,
  type EuipoStoredFindingRawData,
  type EuipoTrademarkCandidate,
  type GitHubChunkAnalysisItem,
  type GitHubRepoCandidate,
  type GitHubRunContext,
  type GitHubStoredFindingRawData,
  type GoogleChunkAnalysisItem,
  type GoogleRunContext,
  type GoogleSearchCandidate,
  type GoogleSearchSighting,
  type GoogleStoredFindingRawData,
  type RedditChunkAnalysisItem,
  type RedditPostCandidate,
  type RedditRunContext,
  type RedditStoredFindingRawData,
  type TikTokChunkAnalysisItem,
  type TikTokRunContext,
  type TikTokStoredFindingRawData,
  type TikTokVideoCandidate,
  type VerifiedRedditCommentSnapshot,
  type VerifiedRedditPostSnapshot,
  type XChunkAnalysisItem,
  type XRunContext,
  type XStoredFindingRawData,
  type XTweetCandidate,
} from '@/lib/analysis/types';
import type {
  ActorRunInfo,
  BrandProfile,
  Finding,
  GoogleScannerId,
  Scan,
  XFindingMatchBasis,
} from '@/lib/types';
import {
  getEffectiveScanSettings,
} from '@/lib/brands';
import { rebuildAndPersistDashboardBreakdownsForScanIds } from '@/lib/dashboard-aggregates';
import { loadBrandFindingTaxonomy } from '@/lib/findings-taxonomy';
import { buildScanAiSummary, type BuiltScanAiSummaryResult } from '@/lib/scan-summary';
import {
  GOOGLE_SEARCH_ACTOR_ID,
  REDDIT_POST_SCRAPER_ACTOR_ID,
  TIKTOK_POST_SCRAPER_ACTOR_ID,
  buildGoogleScannerQuery,
  getScannerConfigById,
  getScannerConfigBySource,
  sanitizeGoogleQueryForDisplay,
  type GoogleScannerConfig,
  type RedditScannerConfig,
  type ScannerConfig,
  type TikTokScannerConfig,
  type XScannerConfig,
} from '@/lib/scan-sources';
import { sendCompletedScanSummaryEmailIfNeeded } from '@/lib/scan-summary-emails';
import {
  generateAndPersistDashboardExecutiveSummary,
  markDashboardExecutiveSummaryPending,
} from '@/lib/dashboard-executive-summary';
import { scheduleDashboardExecutiveSummaryTaskOrRunInline } from '@/lib/dashboard-summary-tasks';
import { buildCountOnlyScanAiSummary, clearBrandActiveScanIfMatches, scanFromSnapshot } from '@/lib/scans';

/** Maximum normalized candidates per LLM request chunk. */
const GOOGLE_ANALYSIS_CHUNK_SIZE = 10;
const GOOGLE_ANALYSIS_CONCURRENCY = 6;
const REDDIT_ANALYSIS_CHUNK_SIZE = 10;
const REDDIT_ANALYSIS_CONCURRENCY = 6;
const TIKTOK_ANALYSIS_CHUNK_SIZE = 10;
const TIKTOK_ANALYSIS_CONCURRENCY = 6;
const REDDIT_VERIFICATION_CONCURRENCY = 4;
const REDDIT_JSON_FETCH_TIMEOUT_MS = 8000;
const MAX_REDDIT_POST_TITLE_LENGTH = 300;
const MAX_REDDIT_POST_SELFTEXT_LENGTH = 4000;
const MAX_REDDIT_COMMENT_BODY_LENGTH = 2000;
const DISCORD_ANALYSIS_CHUNK_SIZE = 10;
const DISCORD_ANALYSIS_CONCURRENCY = 6;
const DOMAIN_REGISTRATION_ANALYSIS_CHUNK_SIZE = 10;
const DOMAIN_REGISTRATION_ANALYSIS_CONCURRENCY = 6;
const GITHUB_ANALYSIS_CHUNK_SIZE = 10;
const GITHUB_ANALYSIS_CONCURRENCY = 6;
const EUIPO_ANALYSIS_CHUNK_SIZE = 10;
const EUIPO_ANALYSIS_CONCURRENCY = 6;
const X_ANALYSIS_CHUNK_SIZE = 10;
const X_ANALYSIS_CONCURRENCY = 6;
const FINDING_UPSERT_CONCURRENCY = 15;
const MAX_GOOGLE_CONTEXT_SOURCE_QUERIES = 5;
const GOOGLE_FINDING_ID_PREFIX = 'google';
const GOOGLE_RAW_DATA_VERSION = 3;
const REDDIT_FINDING_ID_PREFIX = 'reddit';
const REDDIT_RAW_DATA_VERSION = 1;
const TIKTOK_FINDING_ID_PREFIX = 'tiktok';
const TIKTOK_RAW_DATA_VERSION = 1;
const DISCORD_FINDING_ID_PREFIX = 'discord';
const DISCORD_RAW_DATA_VERSION = 1;
const DOMAIN_REGISTRATION_FINDING_ID_PREFIX = 'domains';
const DOMAIN_REGISTRATION_RAW_DATA_VERSION = 1;
const GITHUB_FINDING_ID_PREFIX = 'github';
const GITHUB_RAW_DATA_VERSION = 1;
const EUIPO_FINDING_ID_PREFIX = 'euipo';
const EUIPO_RAW_DATA_VERSION = 1;
const X_FINDING_ID_PREFIX = 'x';
const X_RAW_DATA_VERSION = 1;
type ScanDocHandle = {
  id: string;
  ref: DocumentReference;
};

class ScanProcessingStoppedError extends Error {
  constructor(
    readonly scanId: string,
    readonly reason: 'missing' | 'cancelled',
  ) {
    super(
      reason === 'missing'
        ? `Scan ${scanId} no longer exists`
        : `Scan ${scanId} was cancelled while processing was still in flight`,
    );
    this.name = 'ScanProcessingStoppedError';
  }
}

function isScanProcessingStoppedError(error: unknown): error is ScanProcessingStoppedError {
  return error instanceof ScanProcessingStoppedError;
}

function isFirestoreNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 5;
}

async function updateScanProcessingState(
  scanDoc: ScanDocHandle,
  updates: Record<string, unknown>,
) {
  try {
    await scanDoc.ref.update(updates);
  } catch (error) {
    if (isFirestoreNotFoundError(error)) {
      throw new ScanProcessingStoppedError(scanDoc.id, 'missing');
    }
    throw error;
  }
}

const TRACKING_QUERY_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'msclkid',
]);

const GOOGLE_URL_SUPPRESSION_SOURCES: Finding['source'][] = [
  'google',
  'youtube',
  'facebook',
  'instagram',
  'telegram',
  'apple_app_store',
  'google_play',
];

const REDDIT_POST_ID_SUPPRESSION_SOURCES: Finding['source'][] = ['reddit', 'google'];

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
      await drainQueuedActorRunsIfCapacity(scanDoc, webhookUrl);
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

    await drainQueuedActorRunsIfCapacity(scanDoc, webhookUrl);
    try {
      await handleSucceededRun({
        runId: resource.id,
        datasetId: resource.defaultDatasetId,
        scanDoc,
        scan: claim.scan,
        webhookUrl,
      });
    } catch (err) {
      if (isScanProcessingStoppedError(err)) {
        console.log(
          `[webhook] Stopping succeeded-run processing for ${resource.id} because scan ${err.scanId} is ${err.reason === 'missing' ? 'gone' : 'cancelled'}`,
        );
        return NextResponse.json({ received: true });
      }
      await recoverFromSucceededRunError({
        scanDoc,
        runId: resource.id,
        err,
      });
    }
  } else if (resource.status === 'FAILED' || resource.status === 'ABORTED') {
    console.warn(`[webhook] Actor run ${resource.id} ended with status: ${resource.status}`);
    await markActorRunComplete(scanDoc, resource.id, 'failed');
    const launchedCount = await drainQueuedActorRunsIfCapacity(scanDoc, webhookUrl);
    if (launchedCount === 0) {
      await finalizeIdleScanIfNoRemainingWork(scanDoc);
    }
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

function readActorRunSearchQueries(actorRunInfo?: Partial<ActorRunInfo>): string[] {
  const explicit = Array.isArray(actorRunInfo?.searchQueries)
    ? actorRunInfo.searchQueries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (explicit.length > 0) {
    return uniqueStrings(explicit);
  }
  return typeof actorRunInfo?.searchQuery === 'string' && actorRunInfo.searchQuery.trim().length > 0
    ? [actorRunInfo.searchQuery.trim()]
    : [];
}

function readActorRunDisplayQueries(actorRunInfo?: Partial<ActorRunInfo>): string[] {
  const explicit = Array.isArray(actorRunInfo?.displayQueries)
    ? actorRunInfo.displayQueries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (explicit.length > 0) {
    return uniqueStrings(explicit);
  }
  return typeof actorRunInfo?.displayQuery === 'string' && actorRunInfo.displayQuery.trim().length > 0
    ? [actorRunInfo.displayQuery.trim()]
    : [];
}

function joinRunQueriesForStorage(values: string[]): string | undefined {
  return values.length > 0 ? values.join(' | ') : undefined;
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
  const effectiveSettings = getEffectiveScanSettings(brand, scan.effectiveSettings);

  // Determine the source (surface) for this actor run
  const actorRunInfo = scan.actorRuns?.[runId];
  const scannerConfig = resolveScannerConfig(actorRunInfo);
  const source = actorRunInfo?.source ?? scannerConfig.source;
  const actorId = actorRunInfo?.actorId ?? scannerConfig.actorId;
  const searchDepth = actorRunInfo?.searchDepth ?? 0;
  const searchQueries = readActorRunSearchQueries(actorRunInfo);
  const displayQueries = readActorRunDisplayQueries(actorRunInfo);
  const searchQuery = actorRunInfo?.searchQuery
    ?? joinRunQueriesForStorage(searchQueries);
  const displayQuery = actorRunInfo?.displayQuery
    ?? joinRunQueriesForStorage(displayQueries)
    ?? (
      searchQuery
        ? (scannerConfig.kind === 'google' ? sanitizeGoogleQueryForDisplay(searchQuery) : searchQuery)
        : undefined
    );
  const maxSuggestedSearches = effectiveSettings.maxAiDeepSearches;
  const userPreferenceHints = scan.userPreferenceHints;
  const previousFindingUrls = scannerConfig.kind === 'google'
    ? await loadPreviousFindingUrls({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousRedditPostIds = scannerConfig.kind === 'reddit'
    ? await loadPreviousRedditPostIds({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousTikTokVideoIds = scannerConfig.kind === 'tiktok'
    ? await loadPreviousTikTokVideoIds({
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
  const previousDomainRegistrationDomains = scannerConfig.kind === 'domains'
    ? await loadPreviousDomainRegistrationDomains({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousGitHubRepoFullNames = scannerConfig.kind === 'github'
    ? await loadPreviousGitHubRepoFullNames({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousEuipoApplicationNumbers = scannerConfig.kind === 'euipo'
    ? await loadPreviousEuipoApplicationNumbers({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousXTweetIds = scannerConfig.kind === 'x'
    ? await loadPreviousXTweetIds({
      brandId: scan.brandId,
      userId: scan.userId,
      currentScanId: scan.id ?? scanDoc.id,
    })
    : undefined;
  const previousXAccountKeys = scannerConfig.kind === 'x'
    ? await loadPreviousXAccountKeys({
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

  // Phase 2 → Phase 3: signal that AI analysis is starting, and record total item count
  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.status`]: 'analysing',
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
      items,
      searchDepth,
      searchQuery,
      displayQuery,
      userPreferenceHints,
      previousFindingUrls,
      existingTaxonomy,
      scannerConfig,
    })
    : scannerConfig.kind === 'reddit'
      ? await analyseAndWriteRedditBatch({
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
        displayQuery,
        userPreferenceHints,
        previousPostIds: previousRedditPostIds,
        existingTaxonomy,
        scannerConfig,
        effectiveSettings,
      })
    : scannerConfig.kind === 'tiktok'
      ? await analyseAndWriteTikTokBatch({
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
        searchQueries,
        displayQuery,
        displayQueries,
        userPreferenceHints,
        previousVideoIds: previousTikTokVideoIds,
        existingTaxonomy,
        scannerConfig,
        effectiveSettings,
      })
    : scannerConfig.kind === 'discord'
      ? await analyseAndWriteDiscordBatch({
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
        displayQuery,
        userPreferenceHints,
        previousServerIds: previousDiscordServerIds,
        existingTaxonomy,
        scannerConfig,
      })
      : scannerConfig.kind === 'domains'
        ? await analyseAndWriteDomainRegistrationBatch({
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
          displayQuery,
          userPreferenceHints,
          previousDomains: previousDomainRegistrationDomains,
          existingTaxonomy,
          scannerConfig,
        })
      : scannerConfig.kind === 'github'
        ? await analyseAndWriteGitHubBatch({
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
          displayQuery,
          userPreferenceHints,
          previousRepoFullNames: previousGitHubRepoFullNames,
          existingTaxonomy,
          scannerConfig,
        })
      : scannerConfig.kind === 'euipo'
        ? await analyseAndWriteEuipoBatch({
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
          displayQuery,
          userPreferenceHints,
          previousApplicationNumbers: previousEuipoApplicationNumbers,
          existingTaxonomy,
          scannerConfig,
        })
      : scannerConfig.kind === 'x'
        ? await analyseAndWriteXBatch({
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
          displayQuery,
          userPreferenceHints,
          previousTweetIds: previousXTweetIds,
          previousAccountKeys: previousXAccountKeys,
          existingTaxonomy,
          scannerConfig,
        })
        : (() => {
          throw new Error(`Unsupported scanner kind: ${String((scannerConfig as { kind?: string }).kind)}`);
        })();
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
    scannerConfig.supportsDeepSearch &&
    effectiveSettings.allowAiDeepSearches
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
    `[webhook] Actor ${actorId} (run ${runId}, scanner ${scannerConfig.id}, depth ${searchDepth}): ${newFindingCount} findings written from ${items.length} raw items, ${skippedDuplicateCount} skipped as previous duplicates (mode: ${scannerConfig.kind}-batch)`,
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
    .where('source', 'in', GOOGLE_URL_SUPPRESSION_SOURCES)
    .select('scanId', 'canonicalId', 'url')
    .get();

  const urls = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; url?: string };
    if (data.scanId === currentScanId) {
      continue;
    }

    const normalizedUrl = normalizeStoredCanonicalId(data.canonicalId)
      ?? (typeof data.url === 'string' ? normalizeUrlForFinding(data.url) : null);
    if (normalizedUrl) {
      urls.add(normalizedUrl);
    }
  }

  return urls;
}

async function loadPreviousRedditPostIds({
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
    .where('source', 'in', REDDIT_POST_ID_SUPPRESSION_SOURCES)
    .select('scanId', 'source', 'canonicalId', 'rawData', 'url')
    .get();

  const postIds = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as {
      scanId?: string;
      source?: Finding['source'];
      canonicalId?: string;
      rawData?: Record<string, unknown>;
      url?: string;
    };
    if (data.scanId === currentScanId) {
      continue;
    }

    const postId = data.source === 'reddit'
      ? normalizeStoredCanonicalId(data.canonicalId)
        ?? readRedditStoredFindingRawData(data.rawData)?.post.id
      : readGoogleStoredFindingRawData(data.rawData)?.verifiedRedditPost?.postId
        ?? extractRedditPostIdFromUrl(readGoogleStoredFindingRawData(data.rawData)?.normalizedUrl)
        ?? extractRedditPostIdFromUrl(data.url)
        ?? extractRedditPostIdFromUrl(normalizeStoredCanonicalId(data.canonicalId) ?? undefined);
    if (typeof postId === 'string' && postId.trim().length > 0) {
      postIds.add(postId.trim());
    }
  }

  return postIds;
}

async function loadPreviousTikTokVideoIds({
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
    .where('source', '==', 'tiktok')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const videoIds = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const videoId = normalizeStoredCanonicalId(data.canonicalId)
      ?? readTikTokStoredFindingRawData(data.rawData)?.video.id;
    if (typeof videoId === 'string' && videoId.trim().length > 0) {
      videoIds.add(videoId.trim());
    }
  }

  return videoIds;
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
    .where('source', '==', 'discord')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const serverIds = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const serverId = normalizeStoredCanonicalId(data.canonicalId)
      ?? readDiscordStoredFindingRawData(data.rawData)?.server.id;
    if (typeof serverId === 'string' && serverId.trim().length > 0) {
      serverIds.add(serverId.trim());
    }
  }

  return serverIds;
}

async function loadPreviousDomainRegistrationDomains({
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
    .where('source', '==', 'domains')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const domains = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const domain = normalizeStoredCanonicalId(data.canonicalId, { lowerCase: true })
      ?? readDomainRegistrationStoredFindingRawData(data.rawData)?.domainRecord.domain?.trim().toLowerCase();
    if (typeof domain === 'string' && domain.trim().length > 0) {
      domains.add(domain.trim().toLowerCase());
    }
  }

  return domains;
}

async function loadPreviousGitHubRepoFullNames({
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
    .where('source', '==', 'github')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const repoFullNames = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const fullName = normalizeStoredCanonicalId(data.canonicalId, { lowerCase: true })
      ?? readGitHubStoredFindingRawData(data.rawData)?.repo.fullName?.trim().toLowerCase();
    if (typeof fullName === 'string' && fullName.trim().length > 0) {
      repoFullNames.add(fullName.trim().toLowerCase());
    }
  }

  return repoFullNames;
}

async function loadPreviousEuipoApplicationNumbers({
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
    .where('source', '==', 'euipo')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const applicationNumbers = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const applicationNumber = normalizeStoredCanonicalId(data.canonicalId)
      ?? readEuipoStoredFindingRawData(data.rawData)?.trademark.applicationNumber;
    if (typeof applicationNumber === 'string' && applicationNumber.trim().length > 0) {
      applicationNumbers.add(applicationNumber.trim());
    }
  }

  return applicationNumbers;
}

async function loadPreviousXTweetIds({
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
    .where('source', '==', 'x')
    .select('scanId', 'canonicalId', 'rawData')
    .get();

  const tweetIds = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as { scanId?: string; canonicalId?: string; rawData?: Record<string, unknown> };
    if (data.scanId === currentScanId) {
      continue;
    }

    const tweetId = normalizeStoredCanonicalId(data.canonicalId)
      ?? readXStoredFindingRawData(data.rawData)?.tweet.id;
    if (typeof tweetId === 'string' && tweetId.trim().length > 0) {
      tweetIds.add(tweetId.trim());
    }
  }

  return tweetIds;
}

async function loadPreviousXAccountKeys({
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
    .where('source', '==', 'x')
    .select('scanId', 'isFalsePositive', 'xAuthorId', 'xAuthorHandle')
    .get();

  const accountKeys = new Set<string>();
  for (const doc of previousFindingsSnap.docs) {
    const data = doc.data() as {
      scanId?: string;
      isFalsePositive?: boolean;
      xAuthorId?: string;
      xAuthorHandle?: string;
    };
    if (data.scanId === currentScanId || data.isFalsePositive === true) {
      continue;
    }

    const accountKey = buildXAccountKey({
      authorId: data.xAuthorId,
      authorHandle: data.xAuthorHandle,
    });
    if (accountKey) {
      accountKeys.add(accountKey);
    }
  }

  return accountKeys;
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
  const effectiveSettings = getEffectiveScanSettings(brand, scan.effectiveSettings);
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const canRunDeepSearchSelection = searchDepth === 0 && effectiveSettings.allowAiDeepSearches;
  const maxSuggestedSearches = effectiveSettings.maxAiDeepSearches;

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
  const verifiedCandidates = source === 'reddit'
    ? await enrichGoogleRedditCandidatesWithVerifiedPosts(candidatesToAnalyse)
    : candidatesToAnalyse;
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: verifiedCandidates.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (verifiedCandidates.length === 0) {
    return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();
  const chunks = chunkArray(verifiedCandidates, GOOGLE_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    GOOGLE_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<GoogleChunkAnalysisResult | null> => {
      const prompt = buildGoogleChunkAnalysisPrompt({
        scanner: scannerConfig,
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
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
        return await retryChunkAnalysisOnce({
          sourceLabel: 'Google',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseGoogleChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
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

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertGoogleFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
}

async function analyseAndWriteRedditBatch({
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
  previousPostIds,
  existingTaxonomy,
  effectiveSettings,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  scannerConfig: RedditScannerConfig;
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  userPreferenceHints?: Scan['userPreferenceHints'];
  previousPostIds?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
  effectiveSettings: ReturnType<typeof getEffectiveScanSettings>;
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const canRunDeepSearchSelection = searchDepth === 0 && effectiveSettings.allowAiDeepSearches;
  const maxSuggestedSearches = effectiveSettings.maxAiDeepSearches;

  const normalizedRun = normalizeRedditRun({
    searchQuery,
    displayQuery,
    lookbackDate: effectiveSettings.lookbackDate,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousPostIds?.has(candidate.postId),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: RedditPostCandidate; outcome: RedditFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, REDDIT_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    REDDIT_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<RedditChunkAnalysisResult | null> => {
      const prompt = buildRedditChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(REDDIT_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'Reddit',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseRedditChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [postId, value] of chunkResult.outcomes.entries()) {
      outcomes.set(postId, value);
    }
  }

  if (canRunDeepSearchSelection) {
    suggestedSearches = await finalizeRedditSuggestedSearches({
      brand,
      scannerConfig,
      runContext: normalizedRun.runContext,
      maxSuggestedSearches,
    });
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertRedditFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
}

async function analyseAndWriteTikTokBatch({
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
  searchQueries,
  displayQuery,
  displayQueries,
  userPreferenceHints,
  previousVideoIds,
  existingTaxonomy,
  effectiveSettings,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  scannerConfig: TikTokScannerConfig;
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  searchQueries?: string[];
  displayQuery?: string;
  displayQueries?: string[];
  userPreferenceHints?: Scan['userPreferenceHints'];
  previousVideoIds?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
  effectiveSettings: ReturnType<typeof getEffectiveScanSettings>;
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const canRunDeepSearchSelection = searchDepth === 0 && effectiveSettings.allowAiDeepSearches;
  const maxSuggestedSearches = effectiveSettings.maxAiDeepSearches;

  const normalizedRun = normalizeTikTokRun({
    searchQuery,
    searchQueries,
    displayQuery,
    displayQueries,
    lookbackDate: effectiveSettings.lookbackDate,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousVideoIds?.has(candidate.videoId),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: TikTokVideoCandidate; outcome: TikTokFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, TIKTOK_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    TIKTOK_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<TikTokChunkAnalysisResult | null> => {
      const prompt = buildTikTokChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(TIKTOK_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'TikTok',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseTikTokChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [videoId, value] of chunkResult.outcomes.entries()) {
      outcomes.set(videoId, value);
    }
  }

  if (canRunDeepSearchSelection) {
    suggestedSearches = await finalizeTikTokSuggestedSearches({
      brand,
      scannerConfig,
      runContext: normalizedRun.runContext,
      maxSuggestedSearches,
    });
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertTikTokFinding({
      scanDoc,
      scan,
      source,
      actorId,
      runId,
      searchDepth,
      searchQuery,
      searchQueries,
      displayQuery,
      displayQueries,
      candidate,
      runContext: normalizedRun.runContext,
      outcome,
      scannerConfig,
    }),
  );

  for (const delta of deltas) {
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
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);

  const normalizedRun = normalizeDiscordServerRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousServerIds?.has(candidate.serverId),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, DISCORD_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    DISCORD_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<DiscordChunkAnalysisResult | null> => {
      const prompt = buildDiscordChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
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
        return await retryChunkAnalysisOnce({
          sourceLabel: 'Discord',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseDiscordChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [serverId, value] of chunkResult.outcomes.entries()) {
      outcomes.set(serverId, value);
    }
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertDiscordFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, counts, skippedDuplicateCount };
}

async function analyseAndWriteDomainRegistrationBatch({
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
  previousDomains,
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
  previousDomains?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);

  const normalizedRun = normalizeDomainRegistrationRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousDomains?.has(candidate.domain.toLowerCase()),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: DomainRegistrationCandidate; outcome: DomainRegistrationFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, DOMAIN_REGISTRATION_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    DOMAIN_REGISTRATION_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<DomainRegistrationChunkAnalysisResult | null> => {
      const prompt = buildDomainRegistrationChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(DOMAIN_REGISTRATION_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'Domain-registration',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseDomainRegistrationChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [domain, value] of chunkResult.outcomes.entries()) {
      outcomes.set(domain, value);
    }
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertDomainRegistrationFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, counts, skippedDuplicateCount };
}

async function analyseAndWriteXBatch({
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
  previousTweetIds,
  previousAccountKeys,
  existingTaxonomy,
}: {
  scanDoc: ScanDocHandle;
  scan: Scan;
  brand: BrandProfile;
  source: Finding['source'];
  scannerConfig: XScannerConfig;
  actorId: string;
  datasetId: string;
  runId: string;
  items: Record<string, unknown>[];
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  userPreferenceHints?: Scan['userPreferenceHints'];
  previousTweetIds?: ReadonlySet<string>;
  previousAccountKeys?: ReadonlySet<string>;
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
  const effectiveSettings = getEffectiveScanSettings(brand, scan.effectiveSettings);
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const canRunDeepSearchSelection = searchDepth === 0 && effectiveSettings.allowAiDeepSearches;
  const maxSuggestedSearches = effectiveSettings.maxAiDeepSearches;
  const normalizedRun = normalizeXRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousTweetIds?.has(candidate.tweetId),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: XTweetCandidate; outcome: XFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, X_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    X_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<XChunkAnalysisResult | null> => {
      const prompt = buildXChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(X_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'X',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseXChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [tweetId, value] of chunkResult.outcomes.entries()) {
      outcomes.set(tweetId, value);
    }
  }

  if (canRunDeepSearchSelection) {
    suggestedSearches = await finalizeXSuggestedSearches({
      brand,
      scannerConfig,
      runContext: normalizedRun.runContext,
      maxSuggestedSearches,
    });
  }

  const seenRealAccountKeys = new Set(previousAccountKeys ?? []);
  const outcomesToWrite: Array<{
    candidate: XTweetCandidate;
    outcome: XFindingOutcome;
  }> = [];
  for (const { candidate, outcome } of outcomes.values()) {
    const accountKey = buildXAccountKey({
      authorId: candidate.author.id,
      authorHandle: candidate.author.userName,
    });
    if (outcome.matchBasis === 'handle_only' && accountKey && seenRealAccountKeys.has(accountKey)) {
      continue;
    }

    outcomesToWrite.push({ candidate, outcome });

    if (!outcome.isFalsePositive && accountKey) {
      seenRealAccountKeys.add(accountKey);
    }
  }

  const deltas = await mapWithConcurrency(
    outcomesToWrite,
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertXFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, suggestedSearches, counts, skippedDuplicateCount };
}

async function analyseAndWriteGitHubBatch({
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
  previousRepoFullNames,
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
  previousRepoFullNames?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const normalizedRun = normalizeGitHubRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousRepoFullNames?.has(candidate.fullName.toLowerCase()),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: GitHubRepoCandidate; outcome: GitHubFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, GITHUB_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    GITHUB_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<GitHubChunkAnalysisResult | null> => {
      const prompt = buildGitHubChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(GITHUB_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'GitHub',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseGitHubChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [fullName, value] of chunkResult.outcomes.entries()) {
      outcomes.set(fullName, value);
    }
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertGitHubFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, counts, skippedDuplicateCount };
}

async function analyseAndWriteEuipoBatch({
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
  previousApplicationNumbers,
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
  previousApplicationNumbers?: ReadonlySet<string>;
  existingTaxonomy: { themes: string[] };
}): Promise<{
  findingCount: number;
  suggestedSearches?: string[];
  counts: { high: number; medium: number; low: number; nonHit: number };
  skippedDuplicateCount: number;
}> {
  let findingCount = 0;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const severityDefinitions = scan.analysisSeverityDefinitions
    ?? resolveBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions);
  const normalizedRun = normalizeEuipoRun({
    searchQuery,
    displayQuery,
    items,
  });
  const candidatesToAnalyse = normalizedRun.candidates.filter(
    (candidate) => !previousApplicationNumbers?.has(candidate.applicationNumber),
  );
  const skippedDuplicateCount = normalizedRun.candidates.length - candidatesToAnalyse.length;

  await updateScanProcessingState(scanDoc, {
    [`actorRuns.${runId}.itemCount`]: candidatesToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
    [`actorRuns.${runId}.skippedDuplicateCount`]: skippedDuplicateCount,
  });

  if (candidatesToAnalyse.length === 0) {
    return { findingCount, counts, skippedDuplicateCount };
  }

  const outcomes = new Map<string, { candidate: EuipoTrademarkCandidate; outcome: EuipoFindingOutcome }>();
  const chunks = chunkArray(candidatesToAnalyse, EUIPO_ANALYSIS_CHUNK_SIZE);
  const chunkResults = await mapWithConcurrency(
    chunks,
    EUIPO_ANALYSIS_CONCURRENCY,
    async (chunk, chunkIndex): Promise<EuipoChunkAnalysisResult | null> => {
      const prompt = buildEuipoChunkAnalysisPrompt({
        brandName: brand.name,
        keywords: brand.keywords,
        officialDomains: brand.officialDomains,
        severityDefinitions,
        watchWords: brand.watchWords,
        safeWords: brand.safeWords,
        userPreferenceHints,
        existingThemes: existingTaxonomy.themes,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
      });
      const llmAnalysisPrompt = formatLlmPromptForDebug(EUIPO_CLASSIFICATION_SYSTEM_PROMPT, prompt);

      try {
        return await retryChunkAnalysisOnce({
          sourceLabel: 'EUIPO',
          datasetId,
          chunkIndex,
          totalChunks: chunks.length,
          analyse: () => analyseEuipoChunk({
            candidates: chunk,
            prompt,
            llmAnalysisPrompt,
          }),
        });
      } finally {
        await updateScanProcessingState(scanDoc, {
          [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
        });
      }
    },
  );

  for (const chunkResult of chunkResults) {
    if (!chunkResult) continue;
    for (const [applicationNumber, value] of chunkResult.outcomes.entries()) {
      outcomes.set(applicationNumber, value);
    }
  }

  const deltas = await mapWithConcurrency(
    [...outcomes.values()],
    FINDING_UPSERT_CONCURRENCY,
    async ({ candidate, outcome }) => upsertEuipoFinding({
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
    }),
  );

  for (const delta of deltas) {
    findingCount += delta.findingCount;
    counts.high += delta.counts.high;
    counts.medium += delta.counts.medium;
    counts.low += delta.counts.low;
    counts.nonHit += delta.counts.nonHit;
  }

  return { findingCount, counts, skippedDuplicateCount };
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

type RedditFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type RedditChunkAnalysisResult = {
  outcomes: Map<string, { candidate: RedditPostCandidate; outcome: RedditFindingOutcome }>;
};

type TikTokFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type TikTokChunkAnalysisResult = {
  outcomes: Map<string, { candidate: TikTokVideoCandidate; outcome: TikTokFindingOutcome }>;
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

type DomainRegistrationFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type DomainRegistrationChunkAnalysisResult = {
  outcomes: Map<string, { candidate: DomainRegistrationCandidate; outcome: DomainRegistrationFindingOutcome }>;
};

type GitHubFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type GitHubChunkAnalysisResult = {
  outcomes: Map<string, { candidate: GitHubRepoCandidate; outcome: GitHubFindingOutcome }>;
};

type EuipoFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type EuipoChunkAnalysisResult = {
  outcomes: Map<string, { candidate: EuipoTrademarkCandidate; outcome: EuipoFindingOutcome }>;
};

type XFindingOutcome = {
  severity: Finding['severity'];
  title: string;
  theme?: string;
  analysis: string;
  isFalsePositive: boolean;
  matchBasis: XFindingMatchBasis;
  llmAnalysisPrompt?: string;
  rawLlmResponse?: string;
  classificationSource: 'llm' | 'fallback';
};

type XChunkAnalysisResult = {
  outcomes: Map<string, { candidate: XTweetCandidate; outcome: XFindingOutcome }>;
};

type FindingDelta = {
  findingCount: number;
  counts: { high: number; medium: number; low: number; nonHit: number };
};

function emptyFindingDelta(): FindingDelta {
  return {
    findingCount: 0,
    counts: { high: 0, medium: 0, low: 0, nonHit: 0 },
  };
}

async function loadProcessableScanInTransaction(
  tx: Transaction,
  scanDoc: ScanDocHandle,
): Promise<Scan | null> {
  const freshScanSnap = await tx.get(scanDoc.ref);
  if (!freshScanSnap.exists) {
    return null;
  }

  const freshScan = freshScanSnap.data() as Scan;
  if (freshScan.status === 'cancelled') {
    return null;
  }

  return freshScan;
}

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

async function finalizeIdleScanIfNoRemainingWork(scanDoc: ScanDocHandle): Promise<void> {
  const result = await db.runTransaction<MarkActorRunCompleteResult>(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    if (!freshSnap.exists) return { needsSummary: false };

    const fresh = freshSnap.data() as Scan;
    if (fresh.status === 'cancelled' || fresh.status === 'failed' || fresh.status === 'completed' || fresh.status === 'summarising') {
      return { needsSummary: false };
    }
    if (hasQueuedActorLaunchWork(fresh)) {
      return { needsSummary: false };
    }
    if (Object.values(fresh.actorRuns ?? {}).some((run) => isActorRunInFlight(run))) {
      return { needsSummary: false };
    }

    const totalRunCount = fresh.actorRunIds?.length ?? 0;
    const completedRunCount = fresh.completedRunCount ?? 0;
    if (totalRunCount > 0 && completedRunCount < totalRunCount) {
      return { needsSummary: false };
    }

    const hasResults = hasPersistedScanResults({
      findingCount: fresh.findingCount ?? 0,
      highCount: fresh.highCount ?? 0,
      mediumCount: fresh.mediumCount ?? 0,
      lowCount: fresh.lowCount ?? 0,
      nonHitCount: fresh.nonHitCount ?? 0,
      ignoredCount: fresh.ignoredCount ?? 0,
      addressedCount: fresh.addressedCount ?? 0,
      skippedCount: fresh.skippedCount ?? 0,
    });
    const anySucceeded = Object.values(fresh.actorRuns ?? {}).some((run) => run.status === 'succeeded');
    const updates: Record<string, unknown> = {};

    if (anySucceeded || hasResults) {
      updates.status = 'summarising';
      updates.summaryStartedAt = FieldValue.serverTimestamp();
    } else {
      updates.status = 'failed';
      updates.completedAt = FieldValue.serverTimestamp();
      updates.errorMessage = 'All actor runs failed or were aborted';
      await clearBrandActiveScanIfMatches(db.collection('brands').doc(fresh.brandId), scanDoc.id, tx);
    }

    tx.update(scanDoc.ref, updates);
    return { needsSummary: updates.status === 'summarising' };
  });

  if (result.needsSummary) {
    await generateAndPersistScanSummary(scanDoc.ref);
  }
}

type MarkActorRunCompleteOptions = {
  reconcilePersistedCounts?: boolean;
};

type MarkActorRunCompleteResult = {
  needsSummary: boolean;
};

async function retryChunkAnalysisOnce<Result>({
  sourceLabel,
  datasetId,
  chunkIndex,
  totalChunks,
  analyse,
}: {
  sourceLabel: string;
  datasetId: string;
  chunkIndex: number;
  totalChunks: number;
  analyse: () => Promise<Result>;
}): Promise<Result | null> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await analyse();
    } catch (err) {
      const prefix = `[webhook] ${sourceLabel} chunk analysis failed for dataset ${datasetId} (chunk ${chunkIndex + 1}/${totalChunks}, attempt ${attempt}/${maxAttempts})`;
      if (attempt < maxAttempts) {
        console.warn(`${prefix}; retrying chunk once:`, err);
        continue;
      }

      console.error(`${prefix}; dropping chunk results:`, err);
      return null;
    }
  }

  return null;
}

function assertChunkAnalysisCoveredCandidates<Item extends { resultId: string }>(
  sourceLabel: string,
  candidates: Array<{ resultId: string }>,
  byResultId: Map<string, Item>,
): void {
  const missingResultIds = candidates
    .map((candidate) => candidate.resultId)
    .filter((resultId) => !byResultId.has(resultId));

  if (missingResultIds.length === 0) {
    return;
  }

  const preview = missingResultIds.slice(0, 3).join(', ');
  const suffix = missingResultIds.length > 3 ? ', ...' : '';
  throw new Error(
    `${sourceLabel} chunk analysis omitted ${missingResultIds.length} of ${candidates.length} candidates: ${preview}${suffix}`,
  );
}

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

      // TikTok /discover/* pages are SEO aggregate pages, not individual content — exclude them
      // regardless of whether Google honoured the -inurl:/discover operator in the query.
      if (source === 'tiktok' && /tiktok\.com\/discover\//i.test(normalizedUrl)) continue;

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

async function enrichGoogleRedditCandidatesWithVerifiedPosts(
  candidates: GoogleSearchCandidate[],
): Promise<GoogleSearchCandidate[]> {
  return mapWithConcurrency(
    candidates,
    REDDIT_VERIFICATION_CONCURRENCY,
    async (candidate) => {
      const verifiedRedditPost = await fetchVerifiedRedditPostSnapshot(candidate.url);
      if (!verifiedRedditPost) {
        return candidate;
      }

      return {
        ...candidate,
        verifiedRedditPost,
      };
    },
  );
}

async function fetchVerifiedRedditPostSnapshot(url: string): Promise<VerifiedRedditPostSnapshot | undefined> {
  const permalink = extractRedditPermalinkParts(url);
  if (!permalink) {
    return undefined;
  }

  try {
    const response = await fetch(permalink.jsonUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DoppelSpotter/1.0 (+https://doppelspotter.com)',
      },
      signal: AbortSignal.timeout(REDDIT_JSON_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      console.warn(`[webhook] Reddit JSON verification skipped for ${url}: ${response.status}`);
      return undefined;
    }

    const payload = await response.json();
    const snapshot = readVerifiedRedditPostSnapshot(payload, permalink);
    if (!snapshot) {
      console.warn(`[webhook] Reddit JSON verification returned unusable payload for ${url}`);
      return undefined;
    }

    return snapshot;
  } catch (error) {
    console.warn(`[webhook] Reddit JSON verification failed for ${url}:`, error);
    return undefined;
  }
}

function extractRedditPermalinkParts(url: string): {
  canonicalUrl: string;
  jsonUrl: string;
  postId: string;
  commentId?: string;
} | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('reddit.com')) {
      return null;
    }

    const segments = parsed.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length < 4 || segments[0] !== 'r' || segments[2] !== 'comments') {
      return null;
    }

    const postId = segments[3];
    if (!postId) {
      return null;
    }

    const commentId = segments.length >= 6 ? segments[5] : undefined;
    const canonicalPath = `/${segments.join('/')}`;
    return {
      canonicalUrl: `https://www.reddit.com${canonicalPath}`,
      jsonUrl: `https://www.reddit.com${canonicalPath}/.json`,
      postId,
      ...(commentId ? { commentId } : {}),
    };
  } catch {
    return null;
  }
}

function extractRedditPostIdFromUrl(url?: string): string | undefined {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return undefined;
  }

  return extractRedditPermalinkParts(url)?.postId;
}

function readVerifiedRedditPostSnapshot(
  payload: unknown,
  permalink: {
    canonicalUrl: string;
    jsonUrl: string;
    postId: string;
    commentId?: string;
  },
): VerifiedRedditPostSnapshot | undefined {
  if (!Array.isArray(payload) || payload.length < 1) {
    return undefined;
  }

  const postListing = payload[0];
  const postChildren = readRedditListingChildren(postListing);
  const postData = postChildren.find((child) => child.kind === 't3')?.data;
  if (!postData) {
    return undefined;
  }

  const title = trimToLength(readOptionalTrimmedString(postData.title), MAX_REDDIT_POST_TITLE_LENGTH);
  const subreddit = readOptionalTrimmedString(postData.subreddit);
  if (!title || !subreddit) {
    return undefined;
  }
  const selftext = trimToLength(readOptionalTrimmedString(postData.selftext), MAX_REDDIT_POST_SELFTEXT_LENGTH);
  const author = readOptionalTrimmedString(postData.author);
  const postPermalink = readOptionalTrimmedString(postData.permalink);
  const createdUtc = readOptionalFiniteNumber(postData.created_utc);
  const score = readOptionalFiniteNumber(postData.score);
  const numComments = readOptionalFiniteNumber(postData.num_comments);
  const linkFlairText = readOptionalTrimmedString(postData.link_flair_text);
  const domain = readOptionalTrimmedString(postData.domain);

  const matchedComment = permalink.commentId
    ? findVerifiedRedditCommentSnapshot(payload[1], permalink.commentId)
    : undefined;

  return stripUndefinedDeep({
    source: 'reddit-json',
    canonicalUrl: permalink.canonicalUrl,
    jsonUrl: permalink.jsonUrl,
    postId: permalink.postId,
    subreddit,
    title,
    ...(selftext ? { selftext } : {}),
    ...(author ? { author } : {}),
    ...(postPermalink ? { permalink: postPermalink } : {}),
    ...(createdUtc !== undefined ? { createdUtc } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(numComments !== undefined ? { numComments } : {}),
    ...(linkFlairText ? { linkFlairText } : {}),
    ...(typeof postData.is_self === 'boolean' ? { isSelfPost: postData.is_self } : {}),
    ...(domain ? { domain } : {}),
    ...(typeof postData.over_18 === 'boolean' ? { over18: postData.over_18 } : {}),
    ...(matchedComment ? { matchedComment } : {}),
  }) satisfies VerifiedRedditPostSnapshot;
}

function readRedditListingChildren(value: unknown): Array<{ kind?: string; data: Record<string, unknown> }> {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const data = (value as Record<string, unknown>).data;
  if (typeof data !== 'object' || data === null) {
    return [];
  }

  const children = (data as Record<string, unknown>).children;
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      kind: typeof entry.kind === 'string' ? entry.kind : undefined,
      data: typeof entry.data === 'object' && entry.data !== null ? entry.data as Record<string, unknown> : {},
    }));
}

function findVerifiedRedditCommentSnapshot(
  commentsListing: unknown,
  commentId: string,
): VerifiedRedditCommentSnapshot | undefined {
  const targetId = commentId.trim().toLowerCase();
  if (!targetId) {
    return undefined;
  }

  const stack = readRedditListingChildren(commentsListing).map((child) => child.data);
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) continue;

    const currentId = readOptionalTrimmedString(current.id)?.toLowerCase();
    if (currentId === targetId) {
      const body = trimToLength(readOptionalTrimmedString(current.body), MAX_REDDIT_COMMENT_BODY_LENGTH);
      if (!body) {
        return undefined;
      }

      return stripUndefinedDeep({
        id: currentId,
        body,
        ...(readOptionalTrimmedString(current.author) ? { author: readOptionalTrimmedString(current.author) } : {}),
        ...(readOptionalFiniteNumber(current.score) !== undefined ? { score: readOptionalFiniteNumber(current.score) } : {}),
        ...(readOptionalFiniteNumber(current.depth) !== undefined ? { depth: readOptionalFiniteNumber(current.depth) } : {}),
      }) satisfies VerifiedRedditCommentSnapshot;
    }

    const replies = current.replies;
    if (typeof replies === 'object' && replies !== null) {
      stack.push(...readRedditListingChildren(replies).map((child) => child.data));
    }
  }

  return undefined;
}

function normalizeRedditRun({
  searchQuery,
  displayQuery,
  lookbackDate,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  lookbackDate?: string;
  items: Record<string, unknown>[];
}): { candidates: RedditPostCandidate[]; runContext: RedditRunContext } {
  const candidateMap = new Map<string, RedditPostCandidate>();
  const sourceQueries = new Set<string>();
  const observedSubreddits = new Set<string>();
  const observedAuthors = new Set<string>();
  const sampleTitles = new Set<string>();
  let nextResultId = 1;

  for (const sourceQuery of readDelimitedQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const kind = readOptionalTrimmedString(item.kind)?.toLowerCase();
    if (kind !== 'post') continue;

    const postId = readRedditPostId(item);
    const canonicalUrl = readRedditCanonicalUrl(item);
    if (!postId || !canonicalUrl) continue;

    const createdAt = readOptionalTrimmedString(item.created_utc);
    if (!isRedditPostWithinLookback(createdAt, lookbackDate)) continue;

    const title = trimToLength(readOptionalTrimmedString(item.title), MAX_REDDIT_POST_TITLE_LENGTH) ?? `Reddit post ${postId}`;
    const body = trimToLength(readOptionalTrimmedString(item.body), MAX_REDDIT_POST_SELFTEXT_LENGTH);
    const author = readOptionalTrimmedString(item.author);
    const subreddit = readOptionalTrimmedString(item.subreddit) ?? 'unknown';
    const score = readOptionalFiniteNumber(item.score);
    const upvoteRatio = readOptionalFiniteNumber(item.upvote_ratio);
    const numComments = readOptionalFiniteNumber(item.num_comments);
    const flair = readOptionalTrimmedString(item.flair);
    const domain = readOptionalTrimmedString(item.domain);
    const matchedQuery = readOptionalTrimmedString(item.query);
    const over18 = typeof item.over_18 === 'boolean' ? item.over_18 : undefined;
    const isSelfPost = typeof item.is_self === 'boolean' ? item.is_self : undefined;
    const spoiler = typeof item.spoiler === 'boolean' ? item.spoiler : undefined;
    const locked = typeof item.locked === 'boolean' ? item.locked : undefined;
    const isVideo = typeof item.is_video === 'boolean' ? item.is_video : undefined;

    sampleTitles.add(title);
    observedSubreddits.add(subreddit);
    if (author) observedAuthors.add(author);
    if (matchedQuery) sourceQueries.add(matchedQuery);

    const existing = candidateMap.get(postId);
    if (existing) {
      existing.matchedQueries = uniqueStrings([...existing.matchedQueries, ...(matchedQuery ? [matchedQuery] : [])]);
      if (!existing.body && body) existing.body = body;
      if (!existing.author && author) existing.author = author;
      if (existing.createdAt === undefined && createdAt) existing.createdAt = createdAt;
      if (existing.score === undefined && score !== undefined) existing.score = score;
      if (existing.upvoteRatio === undefined && upvoteRatio !== undefined) existing.upvoteRatio = upvoteRatio;
      if (existing.numComments === undefined && numComments !== undefined) existing.numComments = numComments;
      if (!existing.flair && flair) existing.flair = flair;
      if (!existing.domain && domain) existing.domain = domain;
      if (existing.over18 === undefined && over18 !== undefined) existing.over18 = over18;
      if (existing.isSelfPost === undefined && isSelfPost !== undefined) existing.isSelfPost = isSelfPost;
      if (existing.spoiler === undefined && spoiler !== undefined) existing.spoiler = spoiler;
      if (existing.locked === undefined && locked !== undefined) existing.locked = locked;
      if (existing.isVideo === undefined && isVideo !== undefined) existing.isVideo = isVideo;
      continue;
    }

    candidateMap.set(postId, {
      resultId: `rp${nextResultId++}`,
      postId,
      url: canonicalUrl,
      canonicalUrl,
      title,
      ...(body ? { body } : {}),
      ...(author ? { author } : {}),
      subreddit,
      ...(createdAt ? { createdAt } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(upvoteRatio !== undefined ? { upvoteRatio } : {}),
      ...(numComments !== undefined ? { numComments } : {}),
      ...(flair ? { flair } : {}),
      ...(over18 !== undefined ? { over18 } : {}),
      ...(isSelfPost !== undefined ? { isSelfPost } : {}),
      ...(spoiler !== undefined ? { spoiler } : {}),
      ...(locked !== undefined ? { locked } : {}),
      ...(isVideo !== undefined ? { isVideo } : {}),
      ...(domain ? { domain } : {}),
      matchedQueries: matchedQuery ? [matchedQuery] : [],
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      observedSubreddits: uniqueStrings(Array.from(observedSubreddits)),
      observedAuthors: uniqueStrings(Array.from(observedAuthors)),
      sampleTitles: uniqueStrings(Array.from(sampleTitles)).slice(0, 12),
      ...(lookbackDate ? { lookbackDate } : {}),
    },
  };
}

function isRedditPostWithinLookback(createdAt?: string, lookbackDate?: string): boolean {
  if (!createdAt || !lookbackDate) {
    return true;
  }

  const createdAtMs = Date.parse(createdAt);
  const lookbackMs = Date.parse(`${lookbackDate}T00:00:00.000Z`);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(lookbackMs)) {
    return true;
  }

  return createdAtMs >= lookbackMs;
}

function normalizeTikTokRun({
  searchQuery,
  searchQueries,
  displayQuery,
  displayQueries,
  lookbackDate,
  items,
}: {
  searchQuery?: string;
  searchQueries?: string[];
  displayQuery?: string;
  displayQueries?: string[];
  lookbackDate?: string;
  items: Record<string, unknown>[];
}): { candidates: TikTokVideoCandidate[]; runContext: TikTokRunContext } {
  const candidateMap = new Map<string, TikTokVideoCandidate>();
  const sourceQueries = new Set<string>();
  const observedAuthorHandles = new Set<string>();
  const observedHashtags = new Set<string>();
  const sampleCaptions = new Set<string>();
  let nextResultId = 1;

  for (const sourceQuery of uniqueStrings([
    ...(Array.isArray(displayQueries) ? displayQueries : []),
    ...(Array.isArray(searchQueries) ? searchQueries : []),
    ...readDelimitedQueries(displayQuery ?? searchQuery),
  ])) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const videoId = readTikTokVideoId(item);
    const url = readTikTokVideoUrl(item);
    if (!videoId || !url) continue;

    const createdAt = readTikTokCreatedAt(item);
    if (!isTikTokVideoWithinLookback(createdAt, lookbackDate)) continue;

    const caption = trimToLength(readTikTokCaption(item), 2000);
    const region = readOptionalTrimmedString(item.region);
    const author = readTikTokAuthor(item);
    const hashtags = readTikTokHashtags(item);
    const mentions = readTikTokMentions(item);
    const music = readTikTokMusic(item);
    const stats = readTikTokStats(item);
    const matchedQuery = readTikTokMatchedQuery(item);

    if (caption) sampleCaptions.add(caption);
    if (author.uniqueId) observedAuthorHandles.add(author.uniqueId);
    for (const hashtag of hashtags) observedHashtags.add(hashtag);
    if (matchedQuery) sourceQueries.add(matchedQuery);

    const existing = candidateMap.get(videoId);
    if (existing) {
      existing.matchedQueries = uniqueStrings([...existing.matchedQueries, ...(matchedQuery ? [matchedQuery] : [])]);
      if (!existing.caption && caption) existing.caption = caption;
      if (!existing.createdAt && createdAt) existing.createdAt = createdAt;
      if (!existing.region && region) existing.region = region;
      existing.author = mergeTikTokAuthors(existing.author, author);
      existing.hashtags = uniqueStrings([...existing.hashtags, ...hashtags]);
      existing.mentions = uniqueStrings([...existing.mentions, ...mentions]);
      existing.music = mergeTikTokMusic(existing.music, music);
      existing.stats = mergeTikTokStats(existing.stats, stats);
      continue;
    }

    candidateMap.set(videoId, {
      resultId: `tt${nextResultId++}`,
      videoId,
      url,
      ...(caption ? { caption } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(region ? { region } : {}),
      author,
      hashtags,
      mentions,
      ...(music ? { music } : {}),
      stats,
      matchedQueries: matchedQuery ? [matchedQuery] : [],
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      observedAuthorHandles: uniqueStrings(Array.from(observedAuthorHandles)),
      observedHashtags: uniqueStrings(Array.from(observedHashtags)),
      sampleCaptions: uniqueStrings(Array.from(sampleCaptions)).slice(0, 12),
      ...(lookbackDate ? { lookbackDate } : {}),
    },
  };
}

function isTikTokVideoWithinLookback(createdAt?: string, lookbackDate?: string): boolean {
  if (!createdAt || !lookbackDate) {
    return true;
  }

  const createdAtMs = Date.parse(createdAt);
  const lookbackMs = Date.parse(`${lookbackDate}T00:00:00.000Z`);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(lookbackMs)) {
    return true;
  }

  return createdAtMs >= lookbackMs;
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

function normalizeDomainRegistrationRun({
  searchQuery,
  displayQuery,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: DomainRegistrationCandidate[]; runContext: DomainRegistrationRunContext } {
  const candidateMap = new Map<string, DomainRegistrationCandidate>();
  const sourceQueries = new Set<string>();
  const observedTlds = new Set<string>();
  const sampleDomains = new Set<string>();
  let selectedDate: string | undefined;
  let dateComparison: string | undefined;
  let totalLimit: number | undefined;
  let sortField: string | undefined;
  let sortOrder: string | undefined;
  let enhancedAnalysisEnabled = false;
  let enhancedAnalysisModel: string | undefined;
  let nextResultId = 1;

  for (const sourceQuery of readDelimitedQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const domain = readDomainRegistrationDomain(item);
    if (!domain) continue;

    const name = readOptionalTrimmedString(item.name) ?? domain.split('.')[0] ?? domain;
    const tld = readOptionalTrimmedString(item.tld)?.toLowerCase() ?? extractTldFromDomain(domain);
    const registrationDate = readOptionalTrimmedString(item.date);
    const length = readOptionalFiniteNumber(item.length);
    const idn = readOptionalFiniteNumber(item.idn);
    const ipv4 = readOptionalTrimmedString(item.ipv4);
    const ipv6 = readOptionalTrimmedString(item.ipv6);
    const ipAsNumber = readOptionalFiniteNumber(item.ipasnumber);
    const ipAsName = readOptionalTrimmedString(item.ipasname);
    const ipChecked = readOptionalTrimmedString(item.ipchecked);
    const requestMetadata = readDomainRegistrationRequestMetadata(item.requestMetadata);
    const responseMetadata = readDomainRegistrationResponseMetadata(item.responseMetadata);
    const enhancedAnalysis = readDomainRegistrationEnhancedAnalysis(item.enhancedAnalysis);

    if (!selectedDate && requestMetadata?.selectedDate) selectedDate = requestMetadata.selectedDate;
    if (!dateComparison && requestMetadata?.dateComparison) dateComparison = requestMetadata.dateComparison;
    if (totalLimit === undefined && requestMetadata?.totalLimit !== undefined) totalLimit = requestMetadata.totalLimit;
    if (!sortField) sortField = requestMetadata?.sortField ?? responseMetadata?.sortField;
    if (!sortOrder) sortOrder = requestMetadata?.sortOrder ?? responseMetadata?.sortOrder;
    if (tld) observedTlds.add(tld);
    sampleDomains.add(domain);
    if (enhancedAnalysis) {
      enhancedAnalysisEnabled = true;
      if (!enhancedAnalysisModel && enhancedAnalysis.model) {
        enhancedAnalysisModel = enhancedAnalysis.model;
      }
    }

    if (candidateMap.has(domain)) {
      continue;
    }

    candidateMap.set(domain, {
      resultId: `dr${nextResultId++}`,
      domain,
      url: buildDomainRegistrationUrl(domain),
      name,
      tld,
      ...(registrationDate ? { registrationDate } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(idn !== undefined ? { idn } : {}),
      ...(ipv4 ? { ipv4 } : {}),
      ...(ipv6 ? { ipv6 } : {}),
      ...(ipAsNumber !== undefined ? { ipAsNumber } : {}),
      ...(ipAsName ? { ipAsName } : {}),
      ...(ipChecked ? { ipChecked } : {}),
      ...(enhancedAnalysis ? { enhancedAnalysis } : {}),
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      ...(selectedDate ? { selectedDate } : {}),
      ...(dateComparison ? { dateComparison } : {}),
      ...(totalLimit !== undefined ? { totalLimit } : {}),
      ...(sortField ? { sortField } : {}),
      ...(sortOrder ? { sortOrder } : {}),
      observedTlds: uniqueStrings(Array.from(observedTlds)),
      sampleDomains: uniqueStrings(Array.from(sampleDomains)).slice(0, 12),
      enhancedAnalysisEnabled,
      ...(enhancedAnalysisModel ? { enhancedAnalysisModel } : {}),
    },
  };
}

function normalizeXRun({
  searchQuery,
  displayQuery,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: XTweetCandidate[]; runContext: XRunContext } {
  const candidateMap = new Map<string, XTweetCandidate>();
  const sourceQueries = new Set<string>();
  const observedLanguages = new Set<string>();
  const observedAuthors = new Set<string>();
  const sampleTweetTexts = new Set<string>();
  let nextResultId = 1;

  for (const sourceQuery of readDelimitedQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const tweetId = readXTweetId(item);
    const url = readXUrl(item.url);
    if (!tweetId || !url) continue;

    const text = readOptionalTrimmedString(item.text) ?? readOptionalTrimmedString(item.fullText) ?? '';
    if (!text) continue;

    const author = readXAuthor(item.author);
    const twitterUrl = readXUrl(item.twitterUrl);
    const lang = readOptionalTrimmedString(item.lang);
    const createdAt = readOptionalTrimmedString(item.createdAt);
    const retweetCount = readOptionalFiniteNumber(item.retweetCount);
    const replyCount = readOptionalFiniteNumber(item.replyCount);
    const likeCount = readOptionalFiniteNumber(item.likeCount);
    const quoteCount = readOptionalFiniteNumber(item.quoteCount);
    const bookmarkCount = readOptionalFiniteNumber(item.bookmarkCount);
    const quoteId = readOptionalTrimmedString(item.quoteId);
    const isReply = typeof item.isReply === 'boolean' ? item.isReply : undefined;
    const isRetweet = typeof item.isRetweet === 'boolean' ? item.isRetweet : undefined;
    const isQuote = typeof item.isQuote === 'boolean' ? item.isQuote : undefined;

    if (lang) observedLanguages.add(lang);
    if (author.userName) observedAuthors.add(`@${author.userName}`);
    else if (author.name) observedAuthors.add(author.name);
    sampleTweetTexts.add(text.slice(0, 180));

    if (candidateMap.has(tweetId)) {
      continue;
    }

    candidateMap.set(tweetId, {
      resultId: `x${nextResultId++}`,
      tweetId,
      url,
      ...(twitterUrl ? { twitterUrl } : {}),
      text,
      ...(createdAt ? { createdAt } : {}),
      ...(lang ? { lang } : {}),
      ...(retweetCount !== undefined ? { retweetCount } : {}),
      ...(replyCount !== undefined ? { replyCount } : {}),
      ...(likeCount !== undefined ? { likeCount } : {}),
      ...(quoteCount !== undefined ? { quoteCount } : {}),
      ...(bookmarkCount !== undefined ? { bookmarkCount } : {}),
      ...(isReply !== undefined ? { isReply } : {}),
      ...(isRetweet !== undefined ? { isRetweet } : {}),
      ...(isQuote !== undefined ? { isQuote } : {}),
      ...(quoteId ? { quoteId } : {}),
      author,
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      observedLanguages: uniqueStrings(Array.from(observedLanguages)),
      observedAuthors: uniqueStrings(Array.from(observedAuthors)),
      sampleTweetTexts: uniqueStrings(Array.from(sampleTweetTexts)).slice(0, 12),
    },
  };
}

function normalizeGitHubRun({
  searchQuery,
  displayQuery,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: GitHubRepoCandidate[]; runContext: GitHubRunContext } {
  const candidateMap = new Map<string, GitHubRepoCandidate>();
  const sourceQueries = new Set<string>();
  const observedLanguages = new Set<string>();
  const sampleRepoNames = new Set<string>();
  const sampleOwners = new Set<string>();
  let nextResultId = 1;

  for (const sourceQuery of readDelimitedQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const fullName = readGitHubRepoFullName(item);
    if (!fullName) continue;

    const url = buildGitHubRepoUrl(fullName);
    const [owner, name] = splitGitHubFullName(fullName);
    if (!owner || !name) continue;

    const description = readOptionalTrimmedString(item.description);
    const stars = readOptionalFiniteNumber(item.stars);
    const forks = readOptionalFiniteNumber(item.forks);
    const language = readOptionalTrimmedString(item.language);
    const updatedAt = readOptionalTrimmedString(item.updatedAt);

    if (language) observedLanguages.add(language);
    sampleRepoNames.add(name);
    sampleOwners.add(owner);

    if (candidateMap.has(fullName)) {
      continue;
    }

    candidateMap.set(fullName, {
      resultId: `gh${nextResultId++}`,
      fullName,
      url,
      name,
      owner,
      ...(description ? { description } : {}),
      ...(stars !== undefined ? { stars } : {}),
      ...(forks !== undefined ? { forks } : {}),
      ...(language ? { language } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      observedLanguages: uniqueStrings(Array.from(observedLanguages)),
      sampleRepoNames: uniqueStrings(Array.from(sampleRepoNames)).slice(0, 12),
      sampleOwners: uniqueStrings(Array.from(sampleOwners)).slice(0, 12),
    },
  };
}

function normalizeEuipoRun({
  searchQuery,
  displayQuery,
  items,
}: {
  searchQuery?: string;
  displayQuery?: string;
  items: Record<string, unknown>[];
}): { candidates: EuipoTrademarkCandidate[]; runContext: EuipoRunContext } {
  const candidateMap = new Map<string, EuipoTrademarkCandidate>();
  const sourceQueries = new Set<string>();
  const observedStatuses = new Set<string>();
  const observedApplicants = new Set<string>();
  const observedNiceClasses = new Set<string>();
  const sampleMarkNames = new Set<string>();
  let dateFrom: string | undefined;
  let dateTo: string | undefined;
  let maxResults: number | undefined;
  let nextResultId = 1;

  for (const sourceQuery of readDelimitedQueries(displayQuery ?? searchQuery)) {
    sourceQueries.add(sourceQuery);
  }

  for (const item of items) {
    const applicationNumber = readEuipoApplicationNumber(item);
    if (!applicationNumber) continue;

    const markName = readOptionalTrimmedString(item.markName) ?? readOptionalTrimmedString(item.tradeMarkName);
    if (!markName) continue;

    const applicantName = readOptionalTrimmedString(item.applicantName);
    const niceClasses = readOptionalTrimmedString(item.niceClasses);
    const status = readOptionalTrimmedString(item.status);
    const filingDate = readOptionalTrimmedString(item.filingDate);
    const registrationDate = readOptionalTrimmedString(item.registrationDate);
    const expiryDate = readOptionalTrimmedString(item.expiryDate);
    const markType = readOptionalTrimmedString(item.markType);
    const markKind = readOptionalTrimmedString(item.markKind);
    const markBasis = readOptionalTrimmedString(item.markBasis);
    const representativeName = readOptionalTrimmedString(item.representativeName);
    const goodsAndServicesDescription = readOptionalTrimmedString(item.goodsAndServicesDescription);
    const renewalStatus = readOptionalTrimmedString(item.renewalStatus);
    const markImageUrl = readOptionalTrimmedString(item.markImageUrl);
    const euipoUrl = readEuipoUrl(item, applicationNumber);
    const extractedAt = readOptionalTrimmedString(item.extractedAt);

    const requestMetadata = typeof item.requestMetadata === 'object' && item.requestMetadata !== null
      ? item.requestMetadata as Record<string, unknown>
      : null;
    if (!dateFrom) dateFrom = readOptionalTrimmedString(requestMetadata?.dateFrom);
    if (!dateTo) dateTo = readOptionalTrimmedString(requestMetadata?.dateTo);
    if (maxResults === undefined) maxResults = readOptionalFiniteNumber(requestMetadata?.maxResults);

    if (status) observedStatuses.add(status);
    if (applicantName) observedApplicants.add(applicantName);
    if (niceClasses) observedNiceClasses.add(niceClasses);
    sampleMarkNames.add(markName);

    if (candidateMap.has(applicationNumber)) {
      continue;
    }

    candidateMap.set(applicationNumber, {
      resultId: `eu${nextResultId++}`,
      applicationNumber,
      markName,
      ...(applicantName ? { applicantName } : {}),
      ...(niceClasses ? { niceClasses } : {}),
      ...(status ? { status } : {}),
      ...(filingDate ? { filingDate } : {}),
      ...(registrationDate ? { registrationDate } : {}),
      ...(expiryDate ? { expiryDate } : {}),
      ...(markType ? { markType } : {}),
      ...(markKind ? { markKind } : {}),
      ...(markBasis ? { markBasis } : {}),
      ...(representativeName ? { representativeName } : {}),
      ...(goodsAndServicesDescription ? { goodsAndServicesDescription } : {}),
      ...(renewalStatus ? { renewalStatus } : {}),
      ...(markImageUrl ? { markImageUrl } : {}),
      euipoUrl,
      ...(extractedAt ? { extractedAt } : {}),
    });
  }

  return {
    candidates: Array.from(candidateMap.values()),
    runContext: {
      sourceQueries: uniqueStrings(Array.from(sourceQueries)),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
      observedStatuses: uniqueStrings(Array.from(observedStatuses)),
      observedApplicants: uniqueStrings(Array.from(observedApplicants)).slice(0, 12),
      observedNiceClasses: uniqueStrings(Array.from(observedNiceClasses)).slice(0, 12),
      sampleMarkNames: uniqueStrings(Array.from(sampleMarkNames)).slice(0, 12),
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
  assertChunkAnalysisCoveredCandidates('Google', candidates, byResultId);
  const outcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.normalizedUrl, {
      candidate,
      outcome: buildGoogleFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseRedditChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: RedditPostCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<RedditChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: REDDIT_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseRedditChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse Reddit chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('Reddit', candidates, byResultId);
  const outcomes = new Map<string, { candidate: RedditPostCandidate; outcome: RedditFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.postId, {
      candidate,
      outcome: buildRedditFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseTikTokChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: TikTokVideoCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<TikTokChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: TIKTOK_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseTikTokChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse TikTok chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('TikTok', candidates, byResultId);
  const outcomes = new Map<string, { candidate: TikTokVideoCandidate; outcome: TikTokFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.videoId, {
      candidate,
      outcome: buildTikTokFindingOutcome(item, raw, llmAnalysisPrompt),
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
  assertChunkAnalysisCoveredCandidates('Discord', candidates, byResultId);
  const outcomes = new Map<string, { candidate: DiscordServerCandidate; outcome: DiscordFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.serverId, {
      candidate,
      outcome: buildDiscordFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseDomainRegistrationChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: DomainRegistrationCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<DomainRegistrationChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: DOMAIN_REGISTRATION_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseDomainRegistrationChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse domain-registration chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('Domain-registration', candidates, byResultId);
  const outcomes = new Map<string, { candidate: DomainRegistrationCandidate; outcome: DomainRegistrationFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.domain, {
      candidate,
      outcome: buildDomainRegistrationFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseXChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: XTweetCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<XChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: X_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseXChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse X chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('X', candidates, byResultId);
  const outcomes = new Map<string, { candidate: XTweetCandidate; outcome: XFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.tweetId, {
      candidate,
      outcome: buildXFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseGitHubChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: GitHubRepoCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<GitHubChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: GITHUB_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseGitHubChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse GitHub chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('GitHub', candidates, byResultId);
  const outcomes = new Map<string, { candidate: GitHubRepoCandidate; outcome: GitHubFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.fullName, {
      candidate,
      outcome: buildGitHubFindingOutcome(item, raw, llmAnalysisPrompt),
    });
  }

  return { outcomes };
}

async function analyseEuipoChunk({
  candidates,
  prompt,
  llmAnalysisPrompt,
}: {
  candidates: EuipoTrademarkCandidate[];
  prompt: string;
  llmAnalysisPrompt: string;
}): Promise<EuipoChunkAnalysisResult> {
  const raw = await chatCompletion([
    { role: 'system', content: EUIPO_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseEuipoChunkAnalysisOutput(raw, new Set(candidates.map((candidate) => candidate.resultId)));
  if (!parsed) {
    throw new Error(`Failed to parse EUIPO chunk analysis output: ${raw.slice(0, 200)}`);
  }

  const byResultId = new Map(parsed.items.map((item) => [item.resultId, item]));
  assertChunkAnalysisCoveredCandidates('EUIPO', candidates, byResultId);
  const outcomes = new Map<string, { candidate: EuipoTrademarkCandidate; outcome: EuipoFindingOutcome }>();

  for (const candidate of candidates) {
    const item = byResultId.get(candidate.resultId)!;
    outcomes.set(candidate.applicationNumber, {
      candidate,
      outcome: buildEuipoFindingOutcome(item, raw, llmAnalysisPrompt),
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

async function analyseRedditFinalSelection({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: RedditScannerConfig;
  runContext: RedditRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildRedditFinalSelectionPrompt({
    scanner: scannerConfig,
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildRedditFinalSelectionSystemPrompt(maxSuggestedSearches, scannerConfig);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseSuggestedSearchOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse Reddit final selection output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
}

async function analyseTikTokFinalSelection({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: TikTokScannerConfig;
  runContext: TikTokRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildTikTokFinalSelectionPrompt({
    scanner: scannerConfig,
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildTikTokFinalSelectionSystemPrompt(maxSuggestedSearches, scannerConfig);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseSuggestedSearchOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse TikTok final selection output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
}

async function analyseXFinalSelection({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: XScannerConfig;
  runContext: XRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  const prompt = buildXFinalSelectionPrompt({
    scanner: scannerConfig,
    brandName: brand.name,
    keywords: brand.keywords,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    runContext,
    maxSuggestedSearches,
  });
  const systemPrompt = buildXFinalSelectionSystemPrompt(maxSuggestedSearches, scannerConfig);

  const raw = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseSuggestedSearchOutput(raw, maxSuggestedSearches);
  if (!parsed) {
    throw new Error(`Failed to parse X final selection output: ${raw.slice(0, 200)}`);
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

async function finalizeRedditSuggestedSearches({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: RedditScannerConfig;
  runContext: RedditRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseRedditFinalSelection({
      brand,
      scannerConfig,
      runContext,
      maxSuggestedSearches,
    });

    if (!llmSuggestedSearches || llmSuggestedSearches.length === 0) {
      console.log(
        `[webhook] Reddit deep-search final selection subreddits=${runContext.observedSubreddits.length} authors=${runContext.observedAuthors.length} selected=[]`,
      );
      return undefined;
    }

    const sourceQueryKeys = new Set(runContext.sourceQueries.map(normalizeSuggestedSearchKey));
    const filteredSuggestions = llmSuggestedSearches.filter((query) => !sourceQueryKeys.has(normalizeSuggestedSearchKey(query)));
    if (filteredSuggestions.length === 0) {
      console.warn('[webhook] Reddit final deep-search selection returned only source-query duplicates');
      return undefined;
    }

    console.log(
      `[webhook] Reddit deep-search final selection subreddits=${runContext.observedSubreddits.length} authors=${runContext.observedAuthors.length} selected=${JSON.stringify(filteredSuggestions)}`,
    );
    return filteredSuggestions;
  } catch (err) {
    console.error('[webhook] Reddit final deep-search selection failed:', err);
    return undefined;
  }
}

async function finalizeTikTokSuggestedSearches({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: TikTokScannerConfig;
  runContext: TikTokRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseTikTokFinalSelection({
      brand,
      scannerConfig,
      runContext,
      maxSuggestedSearches,
    });

    if (!llmSuggestedSearches || llmSuggestedSearches.length === 0) {
      console.log(
        `[webhook] TikTok deep-search final selection authors=${runContext.observedAuthorHandles.length} hashtags=${runContext.observedHashtags.length} selected=[]`,
      );
      return undefined;
    }

    const sourceQueryKeys = new Set(runContext.sourceQueries.map(normalizeSuggestedSearchKey));
    const filteredSuggestions = llmSuggestedSearches.filter((query) => !sourceQueryKeys.has(normalizeSuggestedSearchKey(query)));
    if (filteredSuggestions.length === 0) {
      console.warn('[webhook] TikTok final deep-search selection returned only source-query duplicates');
      return undefined;
    }

    console.log(
      `[webhook] TikTok deep-search final selection authors=${runContext.observedAuthorHandles.length} hashtags=${runContext.observedHashtags.length} selected=${JSON.stringify(filteredSuggestions)}`,
    );
    return filteredSuggestions;
  } catch (err) {
    console.error('[webhook] TikTok final deep-search selection failed:', err);
    return undefined;
  }
}

async function finalizeXSuggestedSearches({
  brand,
  scannerConfig,
  runContext,
  maxSuggestedSearches,
}: {
  brand: BrandProfile;
  scannerConfig: XScannerConfig;
  runContext: XRunContext;
  maxSuggestedSearches: number;
}): Promise<string[] | undefined> {
  try {
    const llmSuggestedSearches = await analyseXFinalSelection({
      brand,
      scannerConfig,
      runContext,
      maxSuggestedSearches,
    });

    if (!llmSuggestedSearches || llmSuggestedSearches.length === 0) {
      console.log(
        `[webhook] X deep-search final selection authors=${runContext.observedAuthors.length} languages=${runContext.observedLanguages.length} selected=[]`,
      );
      return undefined;
    }

    const sourceQueryKeys = new Set(runContext.sourceQueries.map(normalizeSuggestedSearchKey));
    const filteredSuggestions = llmSuggestedSearches.filter((query) => !sourceQueryKeys.has(normalizeSuggestedSearchKey(query)));
    if (filteredSuggestions.length === 0) {
      console.warn('[webhook] X final deep-search selection returned only source-query duplicates');
      return undefined;
    }

    console.log(
      `[webhook] X deep-search final selection authors=${runContext.observedAuthors.length} languages=${runContext.observedLanguages.length} selected=${JSON.stringify(filteredSuggestions)}`,
    );
    return filteredSuggestions;
  } catch (err) {
    console.error('[webhook] X final deep-search selection failed:', err);
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
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.normalizedUrl,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
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
      canonicalId: candidate.normalizedUrl,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
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

async function upsertRedditFinding({
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
  candidate: RedditPostCandidate;
  runContext: RedditRunContext;
  outcome: RedditFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildRedditFindingId(scanId, candidate.postId));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredRedditOutcome(existing, outcome);
    const mergedRawData = buildRedditStoredFindingRawData({
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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.postId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.url,
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
      canonicalId: candidate.postId,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.url,
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

async function upsertTikTokFinding({
  scanDoc,
  scan,
  source,
  scannerConfig,
  actorId,
  runId,
  searchDepth,
  searchQuery,
  searchQueries,
  displayQuery,
  displayQueries,
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
  searchQueries?: string[];
  displayQuery?: string;
  displayQueries?: string[];
  candidate: TikTokVideoCandidate;
  runContext: TikTokRunContext;
  outcome: TikTokFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildTikTokFindingId(scanId, candidate.videoId));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredTikTokOutcome(existing, outcome);
    const mergedRawData = buildTikTokStoredFindingRawData({
      existingRawData: existing?.rawData,
      candidate,
      runContext,
      source,
      scannerConfig,
      runId,
      searchDepth,
      searchQuery,
      searchQueries,
      displayQuery,
      displayQueries,
      classificationSource: preferredOutcome.classificationSource,
    });
    const preferredSource = choosePreferredFindingSource(existing?.source, source);

    const previousState = existing ? getFindingCountState(existing) : emptyFindingCountState();
    const nextState = getOutcomeCountState(preferredOutcome);

    if (!existing) {
      const finding: Omit<Finding, 'id'> = {
        scanId,
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.videoId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.url,
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
      canonicalId: candidate.videoId,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.url,
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
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.serverId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
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
      canonicalId: candidate.serverId,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
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

async function upsertDomainRegistrationFinding({
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
  candidate: DomainRegistrationCandidate;
  runContext: DomainRegistrationRunContext;
  outcome: DomainRegistrationFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildDomainRegistrationFindingId(scanId, candidate.domain));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredDomainRegistrationOutcome(existing, outcome);
    const mergedRawData = buildDomainRegistrationStoredFindingRawData({
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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.domain.toLowerCase(),
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.url,
        ...(candidate.registrationDate ? { registrationDate: candidate.registrationDate } : {}),
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
      canonicalId: candidate.domain.toLowerCase(),
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.url,
      registrationDate: candidate.registrationDate ?? existing.registrationDate ?? FieldValue.delete(),
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

async function upsertXFinding({
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
  candidate: XTweetCandidate;
  runContext: XRunContext;
  outcome: XFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildXFindingId(scanId, candidate.tweetId));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredXOutcome(existing, outcome);
    const mergedRawData = buildXStoredFindingRawData({
      existingRawData: existing?.rawData,
      candidate,
      runContext,
      source,
      scannerConfig,
      runId,
      searchDepth,
      searchQuery,
      displayQuery,
      matchBasis: preferredOutcome.matchBasis,
      classificationSource: preferredOutcome.classificationSource,
    });
    const preferredSource = choosePreferredFindingSource(existing?.source, source);

    const previousState = existing ? getFindingCountState(existing) : emptyFindingCountState();
    const nextState = getOutcomeCountState(preferredOutcome);

    if (!existing) {
      const finding: Omit<Finding, 'id'> = {
        scanId,
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.tweetId,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.url,
        ...(candidate.author.id ? { xAuthorId: candidate.author.id } : {}),
        ...(candidate.author.userName ? { xAuthorHandle: candidate.author.userName } : {}),
        ...(candidate.author.twitterUrl ? { xAuthorUrl: candidate.author.twitterUrl } : {}),
        xMatchBasis: preferredOutcome.matchBasis,
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
      canonicalId: candidate.tweetId,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.url,
      xAuthorId: candidate.author.id ?? existing.xAuthorId ?? FieldValue.delete(),
      xAuthorHandle: candidate.author.userName ?? existing.xAuthorHandle ?? FieldValue.delete(),
      xAuthorUrl: candidate.author.twitterUrl ?? existing.xAuthorUrl ?? FieldValue.delete(),
      xMatchBasis: preferredOutcome.matchBasis,
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

async function upsertGitHubFinding({
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
  candidate: GitHubRepoCandidate;
  runContext: GitHubRunContext;
  outcome: GitHubFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildGitHubFindingId(scanId, candidate.fullName));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredGitHubOutcome(existing, outcome);
    const mergedRawData = buildGitHubStoredFindingRawData({
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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.fullName.toLowerCase(),
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.url,
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
      canonicalId: candidate.fullName.toLowerCase(),
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.url,
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

async function upsertEuipoFinding({
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
  candidate: EuipoTrademarkCandidate;
  runContext: EuipoRunContext;
  outcome: EuipoFindingOutcome;
}): Promise<FindingDelta> {
  const scanId = scan.id ?? scanDoc.id;
  const findingRef = db.collection('findings').doc(buildEuipoFindingId(scanId, candidate.applicationNumber));

  return db.runTransaction(async (tx) => {
    const freshScan = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!freshScan) {
      return emptyFindingDelta();
    }

    const existingSnap = await tx.get(findingRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Finding) : null;
    const preferredOutcome = choosePreferredEuipoOutcome(existing, outcome);
    const mergedRawData = buildEuipoStoredFindingRawData({
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
        brandId: freshScan.brandId,
        userId: freshScan.userId,
        source: preferredSource,
        actorId,
        canonicalId: candidate.applicationNumber,
        severity: preferredOutcome.severity,
        title: preferredOutcome.title,
        ...(preferredOutcome.theme ? { provisionalTheme: preferredOutcome.theme } : {}),
        description: preferredOutcome.analysis,
        llmAnalysis: preferredOutcome.analysis,
        url: candidate.euipoUrl,
        applicationNumber: candidate.applicationNumber,
        ...(candidate.applicantName ? { applicantName: candidate.applicantName } : {}),
        ...(candidate.filingDate ? { filingDate: candidate.filingDate } : {}),
        ...(candidate.status ? { status: candidate.status } : {}),
        ...(candidate.niceClasses ? { niceClasses: candidate.niceClasses } : {}),
        ...(candidate.markType ? { markType: candidate.markType } : {}),
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
      canonicalId: candidate.applicationNumber,
      severity: preferredOutcome.severity,
      title: preferredOutcome.title,
      platform: FieldValue.delete(),
      theme: existing.theme ?? FieldValue.delete(),
      provisionalTheme: preferredOutcome.theme ?? existing.provisionalTheme ?? existing.theme ?? FieldValue.delete(),
      description: preferredOutcome.analysis,
      llmAnalysis: preferredOutcome.analysis,
      url: candidate.euipoUrl,
      applicationNumber: candidate.applicationNumber,
      applicantName: candidate.applicantName ?? existing.applicantName ?? FieldValue.delete(),
      filingDate: candidate.filingDate ?? existing.filingDate ?? FieldValue.delete(),
      status: candidate.status ?? existing.status ?? FieldValue.delete(),
      niceClasses: candidate.niceClasses ?? existing.niceClasses ?? FieldValue.delete(),
      markType: candidate.markType ?? existing.markType ?? FieldValue.delete(),
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
    const fresh = await loadProcessableScanInTransaction(tx, scanDoc);
    if (!fresh) {
      return [];
    }

    const run = fresh.actorRuns?.[runId] as (ActorRunInfo & { deepSearchSuggestionsProcessed?: boolean }) | undefined;
    if (!run || run.deepSearchSuggestionsProcessed) {
      return [];
    }

    const existingQueries = new Set(
      Object.values(fresh.actorRuns ?? {})
        .flatMap((value) => {
          const existing: string[] = [];
          for (const query of readActorRunSearchQueries(value)) {
            existing.push(normalizeSuggestedSearchKey(query));
          }
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
 * Start follow-up actor runs for each query suggested by AI analysis.
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
  const effectiveSettings = getEffectiveScanSettings(brand, scan.effectiveSettings);
  const queryGroups = queries.map((query) => [query]);
  const queuedActorRuns = queryGroups.flatMap((queryGroup) => {
    try {
      const preparedInput = buildDeepSearchPreparedInput({
        actor: scannerConfig,
        queries: queryGroup,
        searchResultPages: effectiveSettings.searchResultPages,
        lookbackDate: scan.effectiveSettings?.lookbackDate ?? effectiveSettings.lookbackDate,
      });
      return [buildQueuedActorRunInfo(scannerConfig, preparedInput, 1)];
    } catch (err) {
      console.error(`[webhook] Failed to prepare deep search for "${queryGroup.join(' | ')}":`, err);
      return [];
    }
  });

  if (queuedActorRuns.length === 0) return;

  await updateScanProcessingState(scanDoc, {
    queuedActorRuns: FieldValue.arrayUnion(...queuedActorRuns),
  });
  await drainQueuedActorRunsIfCapacity(scanDoc, webhookUrl);

  void scan;
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

function buildRedditFindingOutcome(
  item: RedditChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): RedditFindingOutcome {
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

function buildTikTokFindingOutcome(
  item: TikTokChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): TikTokFindingOutcome {
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

function buildDomainRegistrationFindingOutcome(
  item: DomainRegistrationChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): DomainRegistrationFindingOutcome {
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

function buildXFindingOutcome(
  item: XChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): XFindingOutcome {
  const matchBasis = item.isFalsePositive
    ? 'none'
    : item.matchBasis === 'none'
      ? 'content_only'
      : item.matchBasis;

  return {
    severity: item.severity,
    title: item.title,
    theme: item.theme,
    analysis: item.analysis,
    isFalsePositive: item.isFalsePositive,
    matchBasis,
    llmAnalysisPrompt,
    rawLlmResponse,
    classificationSource: 'llm',
  };
}

function buildGitHubFindingOutcome(
  item: GitHubChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): GitHubFindingOutcome {
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

function buildEuipoFindingOutcome(
  item: EuipoChunkAnalysisItem,
  rawLlmResponse: string,
  llmAnalysisPrompt: string,
): EuipoFindingOutcome {
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

  return stripUndefinedDeep({
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
    verifiedRedditPost: candidate.verifiedRedditPost ?? existing?.verifiedRedditPost,
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
  }) as GoogleStoredFindingRawData;
}

function readGoogleStoredFindingRawData(rawData?: Record<string, unknown>): GoogleStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'google-normalized') {
    return null;
  }
  if (rawData.version !== 1 && rawData.version !== 2 && rawData.version !== GOOGLE_RAW_DATA_VERSION) {
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
    verifiedRedditPost: normalizeVerifiedRedditPostSnapshot(rawData.verifiedRedditPost),
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

function buildRedditStoredFindingRawData({
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
  candidate: RedditPostCandidate;
  runContext: RedditRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): RedditStoredFindingRawData {
  const existing = readRedditStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'reddit-normalized',
    version: REDDIT_RAW_DATA_VERSION,
    post: {
      id: candidate.postId,
      url: candidate.url,
      canonicalUrl: candidate.canonicalUrl,
      title: candidate.title,
      ...(candidate.body ? { body: candidate.body } : {}),
      ...(candidate.author ? { author: candidate.author } : {}),
      subreddit: candidate.subreddit,
      ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
      ...(candidate.score !== undefined ? { score: candidate.score } : {}),
      ...(candidate.upvoteRatio !== undefined ? { upvoteRatio: candidate.upvoteRatio } : {}),
      ...(candidate.numComments !== undefined ? { numComments: candidate.numComments } : {}),
      ...(candidate.flair ? { flair: candidate.flair } : {}),
      ...(candidate.over18 !== undefined ? { over18: candidate.over18 } : {}),
      ...(candidate.isSelfPost !== undefined ? { isSelfPost: candidate.isSelfPost } : {}),
      ...(candidate.spoiler !== undefined ? { spoiler: candidate.spoiler } : {}),
      ...(candidate.locked !== undefined ? { locked: candidate.locked } : {}),
      ...(candidate.isVideo !== undefined ? { isVideo: candidate.isVideo } : {}),
      ...(candidate.domain ? { domain: candidate.domain } : {}),
      matchedQueries: uniqueStrings([...(existing?.post.matchedQueries ?? []), ...candidate.matchedQueries]),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      observedSubreddits: uniqueStrings([...(existing?.context.observedSubreddits ?? []), ...runContext.observedSubreddits]),
      observedAuthors: uniqueStrings([...(existing?.context.observedAuthors ?? []), ...runContext.observedAuthors]),
      sampleTitles: uniqueStrings([...(existing?.context.sampleTitles ?? []), ...runContext.sampleTitles]).slice(0, 12),
      ...(runContext.lookbackDate ?? existing?.context.lookbackDate
        ? { lookbackDate: runContext.lookbackDate ?? existing?.context.lookbackDate }
        : {}),
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
  }) as RedditStoredFindingRawData;
}

function readRedditStoredFindingRawData(rawData?: Record<string, unknown>): RedditStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'reddit-normalized' || rawData.version !== REDDIT_RAW_DATA_VERSION) {
    return null;
  }

  const post = typeof rawData.post === 'object' && rawData.post !== null ? rawData.post as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'reddit-normalized',
    version: REDDIT_RAW_DATA_VERSION,
    post: {
      id: typeof post.id === 'string' ? post.id : '',
      url: typeof post.url === 'string' ? post.url : '',
      canonicalUrl: typeof post.canonicalUrl === 'string' ? post.canonicalUrl : (typeof post.url === 'string' ? post.url : ''),
      title: typeof post.title === 'string' ? post.title : '',
      body: typeof post.body === 'string' ? post.body : undefined,
      author: typeof post.author === 'string' ? post.author : undefined,
      subreddit: typeof post.subreddit === 'string' ? post.subreddit : '',
      createdAt: typeof post.createdAt === 'string' ? post.createdAt : undefined,
      score: typeof post.score === 'number' ? post.score : undefined,
      upvoteRatio: typeof post.upvoteRatio === 'number' ? post.upvoteRatio : undefined,
      numComments: typeof post.numComments === 'number' ? post.numComments : undefined,
      flair: typeof post.flair === 'string' ? post.flair : undefined,
      over18: typeof post.over18 === 'boolean' ? post.over18 : undefined,
      isSelfPost: typeof post.isSelfPost === 'boolean' ? post.isSelfPost : undefined,
      spoiler: typeof post.spoiler === 'boolean' ? post.spoiler : undefined,
      locked: typeof post.locked === 'boolean' ? post.locked : undefined,
      isVideo: typeof post.isVideo === 'boolean' ? post.isVideo : undefined,
      domain: typeof post.domain === 'string' ? post.domain : undefined,
      matchedQueries: Array.isArray(post.matchedQueries)
        ? post.matchedQueries.filter((value): value is string => typeof value === 'string')
        : [],
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      observedSubreddits: Array.isArray(context.observedSubreddits)
        ? context.observedSubreddits.filter((value): value is string => typeof value === 'string')
        : [],
      observedAuthors: Array.isArray(context.observedAuthors)
        ? context.observedAuthors.filter((value): value is string => typeof value === 'string')
        : [],
      sampleTitles: Array.isArray(context.sampleTitles)
        ? context.sampleTitles.filter((value): value is string => typeof value === 'string')
        : [],
      lookbackDate: typeof context.lookbackDate === 'string' ? context.lookbackDate : undefined,
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'reddit',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'reddit-posts',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  };
}

function buildTikTokStoredFindingRawData({
  existingRawData,
  candidate,
  runContext,
  source,
  scannerConfig,
  runId,
  searchDepth,
  searchQuery,
  searchQueries,
  displayQuery,
  displayQueries,
  classificationSource,
}: {
  existingRawData?: Record<string, unknown>;
  candidate: TikTokVideoCandidate;
  runContext: TikTokRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  searchQueries?: string[];
  displayQuery?: string;
  displayQueries?: string[];
  classificationSource: 'llm' | 'fallback';
}): TikTokStoredFindingRawData {
  const existing = readTikTokStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'tiktok-normalized',
    version: TIKTOK_RAW_DATA_VERSION,
    video: {
      id: candidate.videoId,
      url: candidate.url,
      ...(candidate.caption ? { caption: candidate.caption } : {}),
      ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
      ...(candidate.region ? { region: candidate.region } : {}),
      author: mergeTikTokAuthors(existing?.video.author, candidate.author),
      hashtags: uniqueStrings([...(existing?.video.hashtags ?? []), ...candidate.hashtags]),
      mentions: uniqueStrings([...(existing?.video.mentions ?? []), ...candidate.mentions]),
      ...(mergeTikTokMusic(existing?.video.music, candidate.music) ? { music: mergeTikTokMusic(existing?.video.music, candidate.music) } : {}),
      stats: mergeTikTokStats(existing?.video.stats, candidate.stats),
      matchedQueries: uniqueStrings([...(existing?.video.matchedQueries ?? []), ...candidate.matchedQueries]),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      observedAuthorHandles: uniqueStrings([...(existing?.context.observedAuthorHandles ?? []), ...runContext.observedAuthorHandles]),
      observedHashtags: uniqueStrings([...(existing?.context.observedHashtags ?? []), ...runContext.observedHashtags]),
      sampleCaptions: uniqueStrings([...(existing?.context.sampleCaptions ?? []), ...runContext.sampleCaptions]).slice(0, 12),
      ...(runContext.lookbackDate ?? existing?.context.lookbackDate
        ? { lookbackDate: runContext.lookbackDate ?? existing?.context.lookbackDate }
        : {}),
    },
    analysis: {
      source: classificationSource,
      runId,
      findingSource: source,
      scannerId: scannerConfig.id,
      searchDepth,
      ...(searchQuery ? { searchQuery } : {}),
      ...(searchQueries && searchQueries.length > 0 ? { searchQueries } : {}),
      ...(displayQuery ? { displayQuery } : {}),
      ...(displayQueries && displayQueries.length > 0 ? { displayQueries } : {}),
    },
  }) as TikTokStoredFindingRawData;
}

function readTikTokStoredFindingRawData(rawData?: Record<string, unknown>): TikTokStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'tiktok-normalized' || rawData.version !== TIKTOK_RAW_DATA_VERSION) {
    return null;
  }

  const video = typeof rawData.video === 'object' && rawData.video !== null ? rawData.video as Record<string, unknown> : {};
  const author = typeof video.author === 'object' && video.author !== null ? video.author as Record<string, unknown> : {};
  const music = typeof video.music === 'object' && video.music !== null ? video.music as Record<string, unknown> : undefined;
  const stats = typeof video.stats === 'object' && video.stats !== null ? video.stats as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'tiktok-normalized',
    version: TIKTOK_RAW_DATA_VERSION,
    video: {
      id: typeof video.id === 'string' ? video.id : '',
      url: typeof video.url === 'string' ? video.url : '',
      caption: typeof video.caption === 'string' ? video.caption : undefined,
      createdAt: typeof video.createdAt === 'string' ? video.createdAt : undefined,
      region: typeof video.region === 'string' ? video.region : undefined,
      author: {
        id: typeof author.id === 'string' ? author.id : undefined,
        uniqueId: typeof author.uniqueId === 'string' ? author.uniqueId : undefined,
        nickname: typeof author.nickname === 'string' ? author.nickname : undefined,
        signature: typeof author.signature === 'string' ? author.signature : undefined,
        verified: typeof author.verified === 'boolean' ? author.verified : undefined,
        url: typeof author.url === 'string' ? author.url : undefined,
      },
      hashtags: Array.isArray(video.hashtags)
        ? video.hashtags.filter((value): value is string => typeof value === 'string')
        : [],
      mentions: Array.isArray(video.mentions)
        ? video.mentions.filter((value): value is string => typeof value === 'string')
        : [],
      music: music
        ? {
          id: typeof music.id === 'string' ? music.id : undefined,
          title: typeof music.title === 'string' ? music.title : undefined,
          author: typeof music.author === 'string' ? music.author : undefined,
          ownerHandle: typeof music.ownerHandle === 'string' ? music.ownerHandle : undefined,
          isOriginalSound: typeof music.isOriginalSound === 'boolean' ? music.isOriginalSound : undefined,
        }
        : undefined,
      stats: {
        playCount: typeof stats.playCount === 'number' ? stats.playCount : undefined,
        diggCount: typeof stats.diggCount === 'number' ? stats.diggCount : undefined,
        commentCount: typeof stats.commentCount === 'number' ? stats.commentCount : undefined,
        shareCount: typeof stats.shareCount === 'number' ? stats.shareCount : undefined,
        collectCount: typeof stats.collectCount === 'number' ? stats.collectCount : undefined,
      },
      matchedQueries: Array.isArray(video.matchedQueries)
        ? video.matchedQueries.filter((value): value is string => typeof value === 'string')
        : [],
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      observedAuthorHandles: Array.isArray(context.observedAuthorHandles)
        ? context.observedAuthorHandles.filter((value): value is string => typeof value === 'string')
        : [],
      observedHashtags: Array.isArray(context.observedHashtags)
        ? context.observedHashtags.filter((value): value is string => typeof value === 'string')
        : [],
      sampleCaptions: Array.isArray(context.sampleCaptions)
        ? context.sampleCaptions.filter((value): value is string => typeof value === 'string')
        : [],
      lookbackDate: typeof context.lookbackDate === 'string' ? context.lookbackDate : undefined,
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'tiktok',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'tiktok-posts',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      searchQueries: Array.isArray(analysis.searchQueries)
        ? analysis.searchQueries.filter((value): value is string => typeof value === 'string')
        : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
      displayQueries: Array.isArray(analysis.displayQueries)
        ? analysis.displayQueries.filter((value): value is string => typeof value === 'string')
        : undefined,
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
  return stripUndefinedDeep({
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
  }) as DiscordStoredFindingRawData;
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

function buildDomainRegistrationStoredFindingRawData({
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
  candidate: DomainRegistrationCandidate;
  runContext: DomainRegistrationRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): DomainRegistrationStoredFindingRawData {
  const existing = readDomainRegistrationStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'domain-registration-normalized',
    version: DOMAIN_REGISTRATION_RAW_DATA_VERSION,
    domainRecord: {
      domain: candidate.domain,
      url: candidate.url,
      name: candidate.name,
      tld: candidate.tld,
      ...(candidate.registrationDate ? { registrationDate: candidate.registrationDate } : {}),
      ...(candidate.length !== undefined ? { length: candidate.length } : {}),
      ...(candidate.idn !== undefined ? { idn: candidate.idn } : {}),
      ...(candidate.ipv4 ? { ipv4: candidate.ipv4 } : {}),
      ...(candidate.ipv6 ? { ipv6: candidate.ipv6 } : {}),
      ...(candidate.ipAsNumber !== undefined ? { ipAsNumber: candidate.ipAsNumber } : {}),
      ...(candidate.ipAsName ? { ipAsName: candidate.ipAsName } : {}),
      ...(candidate.ipChecked ? { ipChecked: candidate.ipChecked } : {}),
      ...(candidate.enhancedAnalysis ? { enhancedAnalysis: candidate.enhancedAnalysis } : {}),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      selectedDate: runContext.selectedDate ?? existing?.context.selectedDate,
      dateComparison: runContext.dateComparison ?? existing?.context.dateComparison,
      totalLimit: runContext.totalLimit ?? existing?.context.totalLimit,
      sortField: runContext.sortField ?? existing?.context.sortField,
      sortOrder: runContext.sortOrder ?? existing?.context.sortOrder,
      observedTlds: uniqueStrings([...(existing?.context.observedTlds ?? []), ...runContext.observedTlds]),
      sampleDomains: uniqueStrings([...(existing?.context.sampleDomains ?? []), ...runContext.sampleDomains]).slice(0, 12),
      enhancedAnalysisEnabled: runContext.enhancedAnalysisEnabled || existing?.context.enhancedAnalysisEnabled === true,
      enhancedAnalysisModel: runContext.enhancedAnalysisModel ?? existing?.context.enhancedAnalysisModel,
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
  }) as DomainRegistrationStoredFindingRawData;
}

function readDomainRegistrationStoredFindingRawData(
  rawData?: Record<string, unknown>,
): DomainRegistrationStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'domain-registration-normalized' || rawData.version !== DOMAIN_REGISTRATION_RAW_DATA_VERSION) {
    return null;
  }

  const domainRecord = typeof rawData.domainRecord === 'object' && rawData.domainRecord !== null
    ? rawData.domainRecord as Record<string, unknown>
    : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'domain-registration-normalized',
    version: DOMAIN_REGISTRATION_RAW_DATA_VERSION,
    domainRecord: {
      domain: typeof domainRecord.domain === 'string' ? domainRecord.domain : '',
      url: typeof domainRecord.url === 'string' ? domainRecord.url : '',
      name: typeof domainRecord.name === 'string' ? domainRecord.name : '',
      tld: typeof domainRecord.tld === 'string' ? domainRecord.tld : '',
      registrationDate: typeof domainRecord.registrationDate === 'string' ? domainRecord.registrationDate : undefined,
      length: typeof domainRecord.length === 'number' ? domainRecord.length : undefined,
      idn: typeof domainRecord.idn === 'number' ? domainRecord.idn : undefined,
      ipv4: typeof domainRecord.ipv4 === 'string' ? domainRecord.ipv4 : undefined,
      ipv6: typeof domainRecord.ipv6 === 'string' ? domainRecord.ipv6 : undefined,
      ipAsNumber: typeof domainRecord.ipAsNumber === 'number' ? domainRecord.ipAsNumber : undefined,
      ipAsName: typeof domainRecord.ipAsName === 'string' ? domainRecord.ipAsName : undefined,
      ipChecked: typeof domainRecord.ipChecked === 'string' ? domainRecord.ipChecked : undefined,
      enhancedAnalysis: readDomainRegistrationEnhancedAnalysis(domainRecord.enhancedAnalysis),
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      selectedDate: typeof context.selectedDate === 'string' ? context.selectedDate : undefined,
      dateComparison: typeof context.dateComparison === 'string' ? context.dateComparison : undefined,
      totalLimit: typeof context.totalLimit === 'number' ? context.totalLimit : undefined,
      sortField: typeof context.sortField === 'string' ? context.sortField : undefined,
      sortOrder: typeof context.sortOrder === 'string' ? context.sortOrder : undefined,
      observedTlds: Array.isArray(context.observedTlds)
        ? context.observedTlds.filter((value): value is string => typeof value === 'string')
        : [],
      sampleDomains: Array.isArray(context.sampleDomains)
        ? context.sampleDomains.filter((value): value is string => typeof value === 'string')
        : [],
      enhancedAnalysisEnabled: context.enhancedAnalysisEnabled === true,
      enhancedAnalysisModel: typeof context.enhancedAnalysisModel === 'string' ? context.enhancedAnalysisModel : undefined,
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'domains',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'domain-registrations',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  };
}

function buildXStoredFindingRawData({
  existingRawData,
  candidate,
  runContext,
  source,
  scannerConfig,
  runId,
  searchDepth,
  searchQuery,
  displayQuery,
  matchBasis,
  classificationSource,
}: {
  existingRawData?: Record<string, unknown>;
  candidate: XTweetCandidate;
  runContext: XRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  matchBasis: XFindingMatchBasis;
  classificationSource: 'llm' | 'fallback';
}): XStoredFindingRawData {
  const existing = readXStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'x-normalized',
    version: X_RAW_DATA_VERSION,
    tweet: {
      id: candidate.tweetId,
      url: candidate.url,
      ...(candidate.twitterUrl ? { twitterUrl: candidate.twitterUrl } : {}),
      text: candidate.text,
      ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
      ...(candidate.lang ? { lang: candidate.lang } : {}),
      ...(candidate.retweetCount !== undefined ? { retweetCount: candidate.retweetCount } : {}),
      ...(candidate.replyCount !== undefined ? { replyCount: candidate.replyCount } : {}),
      ...(candidate.likeCount !== undefined ? { likeCount: candidate.likeCount } : {}),
      ...(candidate.quoteCount !== undefined ? { quoteCount: candidate.quoteCount } : {}),
      ...(candidate.bookmarkCount !== undefined ? { bookmarkCount: candidate.bookmarkCount } : {}),
      ...(candidate.isReply !== undefined ? { isReply: candidate.isReply } : {}),
      ...(candidate.isRetweet !== undefined ? { isRetweet: candidate.isRetweet } : {}),
      ...(candidate.isQuote !== undefined ? { isQuote: candidate.isQuote } : {}),
      ...(candidate.quoteId ? { quoteId: candidate.quoteId } : {}),
      author: {
        ...(candidate.author.id ? { id: candidate.author.id } : {}),
        ...(candidate.author.userName ? { userName: candidate.author.userName } : {}),
        ...(candidate.author.name ? { name: candidate.author.name } : {}),
        ...(candidate.author.url ? { url: candidate.author.url } : {}),
        ...(candidate.author.twitterUrl ? { twitterUrl: candidate.author.twitterUrl } : {}),
        ...(candidate.author.isVerified !== undefined ? { isVerified: candidate.author.isVerified } : {}),
        ...(candidate.author.isBlueVerified !== undefined ? { isBlueVerified: candidate.author.isBlueVerified } : {}),
        ...(candidate.author.verifiedType ? { verifiedType: candidate.author.verifiedType } : {}),
        ...(candidate.author.followers !== undefined ? { followers: candidate.author.followers } : {}),
        ...(candidate.author.following !== undefined ? { following: candidate.author.following } : {}),
      },
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      observedLanguages: uniqueStrings([...(existing?.context.observedLanguages ?? []), ...runContext.observedLanguages]),
      observedAuthors: uniqueStrings([...(existing?.context.observedAuthors ?? []), ...runContext.observedAuthors]),
      sampleTweetTexts: uniqueStrings([...(existing?.context.sampleTweetTexts ?? []), ...runContext.sampleTweetTexts]).slice(0, 12),
    },
    analysis: {
      source: classificationSource,
      runId,
      findingSource: source,
      scannerId: scannerConfig.id,
      searchDepth,
      matchBasis,
      ...(searchQuery ? { searchQuery } : {}),
      ...(displayQuery ? { displayQuery } : {}),
    },
  }) as XStoredFindingRawData;
}

function readXStoredFindingRawData(rawData?: Record<string, unknown>): XStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'x-normalized' || rawData.version !== X_RAW_DATA_VERSION) {
    return null;
  }

  const tweet = typeof rawData.tweet === 'object' && rawData.tweet !== null ? rawData.tweet as Record<string, unknown> : {};
  const author = typeof tweet.author === 'object' && tweet.author !== null ? tweet.author as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'x-normalized',
    version: X_RAW_DATA_VERSION,
    tweet: {
      id: typeof tweet.id === 'string' ? tweet.id : '',
      url: typeof tweet.url === 'string' ? tweet.url : '',
      twitterUrl: typeof tweet.twitterUrl === 'string' ? tweet.twitterUrl : undefined,
      text: typeof tweet.text === 'string' ? tweet.text : '',
      createdAt: typeof tweet.createdAt === 'string' ? tweet.createdAt : undefined,
      lang: typeof tweet.lang === 'string' ? tweet.lang : undefined,
      retweetCount: typeof tweet.retweetCount === 'number' ? tweet.retweetCount : undefined,
      replyCount: typeof tweet.replyCount === 'number' ? tweet.replyCount : undefined,
      likeCount: typeof tweet.likeCount === 'number' ? tweet.likeCount : undefined,
      quoteCount: typeof tweet.quoteCount === 'number' ? tweet.quoteCount : undefined,
      bookmarkCount: typeof tweet.bookmarkCount === 'number' ? tweet.bookmarkCount : undefined,
      isReply: typeof tweet.isReply === 'boolean' ? tweet.isReply : undefined,
      isRetweet: typeof tweet.isRetweet === 'boolean' ? tweet.isRetweet : undefined,
      isQuote: typeof tweet.isQuote === 'boolean' ? tweet.isQuote : undefined,
      quoteId: typeof tweet.quoteId === 'string' ? tweet.quoteId : undefined,
      author: {
        id: typeof author.id === 'string' ? author.id : undefined,
        userName: typeof author.userName === 'string' ? author.userName : undefined,
        name: typeof author.name === 'string' ? author.name : undefined,
        url: typeof author.url === 'string' ? author.url : undefined,
        twitterUrl: typeof author.twitterUrl === 'string' ? author.twitterUrl : undefined,
        isVerified: typeof author.isVerified === 'boolean' ? author.isVerified : undefined,
        isBlueVerified: typeof author.isBlueVerified === 'boolean' ? author.isBlueVerified : undefined,
        verifiedType: typeof author.verifiedType === 'string' ? author.verifiedType : undefined,
        followers: typeof author.followers === 'number' ? author.followers : undefined,
        following: typeof author.following === 'number' ? author.following : undefined,
      },
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      observedLanguages: Array.isArray(context.observedLanguages)
        ? context.observedLanguages.filter((value): value is string => typeof value === 'string')
        : [],
      observedAuthors: Array.isArray(context.observedAuthors)
        ? context.observedAuthors.filter((value): value is string => typeof value === 'string')
        : [],
      sampleTweetTexts: Array.isArray(context.sampleTweetTexts)
        ? context.sampleTweetTexts.filter((value): value is string => typeof value === 'string')
        : [],
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'x',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'x-search',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      matchBasis: isXFindingMatchBasis(analysis.matchBasis) ? analysis.matchBasis : undefined,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  };
}

function buildGitHubStoredFindingRawData({
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
  candidate: GitHubRepoCandidate;
  runContext: GitHubRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): GitHubStoredFindingRawData {
  const existing = readGitHubStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'github-normalized',
    version: GITHUB_RAW_DATA_VERSION,
    repo: {
      fullName: candidate.fullName,
      url: candidate.url,
      name: candidate.name,
      owner: candidate.owner,
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.stars !== undefined ? { stars: candidate.stars } : {}),
      ...(candidate.forks !== undefined ? { forks: candidate.forks } : {}),
      ...(candidate.language ? { language: candidate.language } : {}),
      ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      observedLanguages: uniqueStrings([...(existing?.context.observedLanguages ?? []), ...runContext.observedLanguages]),
      sampleRepoNames: uniqueStrings([...(existing?.context.sampleRepoNames ?? []), ...runContext.sampleRepoNames]).slice(0, 12),
      sampleOwners: uniqueStrings([...(existing?.context.sampleOwners ?? []), ...runContext.sampleOwners]).slice(0, 12),
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
  }) as GitHubStoredFindingRawData;
}

function readGitHubStoredFindingRawData(rawData?: Record<string, unknown>): GitHubStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'github-normalized' || rawData.version !== GITHUB_RAW_DATA_VERSION) {
    return null;
  }

  const repo = typeof rawData.repo === 'object' && rawData.repo !== null ? rawData.repo as Record<string, unknown> : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return {
    kind: 'github-normalized',
    version: GITHUB_RAW_DATA_VERSION,
    repo: {
      fullName: typeof repo.fullName === 'string' ? repo.fullName : '',
      url: typeof repo.url === 'string' ? repo.url : '',
      name: typeof repo.name === 'string' ? repo.name : '',
      owner: typeof repo.owner === 'string' ? repo.owner : '',
      description: typeof repo.description === 'string' ? repo.description : undefined,
      stars: typeof repo.stars === 'number' ? repo.stars : undefined,
      forks: typeof repo.forks === 'number' ? repo.forks : undefined,
      language: typeof repo.language === 'string' ? repo.language : undefined,
      updatedAt: typeof repo.updatedAt === 'string' ? repo.updatedAt : undefined,
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      observedLanguages: Array.isArray(context.observedLanguages)
        ? context.observedLanguages.filter((value): value is string => typeof value === 'string')
        : [],
      sampleRepoNames: Array.isArray(context.sampleRepoNames)
        ? context.sampleRepoNames.filter((value): value is string => typeof value === 'string')
        : [],
      sampleOwners: Array.isArray(context.sampleOwners)
        ? context.sampleOwners.filter((value): value is string => typeof value === 'string')
        : [],
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'github',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'github-repos',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  };
}

function buildEuipoStoredFindingRawData({
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
  candidate: EuipoTrademarkCandidate;
  runContext: EuipoRunContext;
  source: Finding['source'];
  scannerConfig: ScannerConfig;
  runId: string;
  searchDepth: number;
  searchQuery?: string;
  displayQuery?: string;
  classificationSource: 'llm' | 'fallback';
}): EuipoStoredFindingRawData {
  const existing = readEuipoStoredFindingRawData(existingRawData);
  return stripUndefinedDeep({
    kind: 'euipo-normalized',
    version: EUIPO_RAW_DATA_VERSION,
    trademark: {
      applicationNumber: candidate.applicationNumber,
      markName: candidate.markName,
      ...(candidate.applicantName ? { applicantName: candidate.applicantName } : {}),
      ...(candidate.niceClasses ? { niceClasses: candidate.niceClasses } : {}),
      ...(candidate.status ? { status: candidate.status } : {}),
      ...(candidate.filingDate ? { filingDate: candidate.filingDate } : {}),
      ...(candidate.registrationDate ? { registrationDate: candidate.registrationDate } : {}),
      ...(candidate.expiryDate ? { expiryDate: candidate.expiryDate } : {}),
      ...(candidate.markType ? { markType: candidate.markType } : {}),
      ...(candidate.markKind ? { markKind: candidate.markKind } : {}),
      ...(candidate.markBasis ? { markBasis: candidate.markBasis } : {}),
      ...(candidate.representativeName ? { representativeName: candidate.representativeName } : {}),
      ...(candidate.goodsAndServicesDescription ? { goodsAndServicesDescription: candidate.goodsAndServicesDescription } : {}),
      ...(candidate.renewalStatus ? { renewalStatus: candidate.renewalStatus } : {}),
      ...(candidate.markImageUrl ? { markImageUrl: candidate.markImageUrl } : {}),
      euipoUrl: candidate.euipoUrl,
      ...(candidate.extractedAt ? { extractedAt: candidate.extractedAt } : {}),
    },
    context: {
      sourceQueries: uniqueStrings([...(existing?.context.sourceQueries ?? []), ...runContext.sourceQueries]),
      dateFrom: runContext.dateFrom ?? existing?.context.dateFrom,
      dateTo: runContext.dateTo ?? existing?.context.dateTo,
      maxResults: runContext.maxResults ?? existing?.context.maxResults,
      observedStatuses: uniqueStrings([...(existing?.context.observedStatuses ?? []), ...runContext.observedStatuses]),
      observedApplicants: uniqueStrings([...(existing?.context.observedApplicants ?? []), ...runContext.observedApplicants]).slice(0, 12),
      observedNiceClasses: uniqueStrings([...(existing?.context.observedNiceClasses ?? []), ...runContext.observedNiceClasses]).slice(0, 12),
      sampleMarkNames: uniqueStrings([...(existing?.context.sampleMarkNames ?? []), ...runContext.sampleMarkNames]).slice(0, 12),
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
  }) as EuipoStoredFindingRawData;
}

function readEuipoStoredFindingRawData(rawData?: Record<string, unknown>): EuipoStoredFindingRawData | null {
  if (!rawData || rawData.kind !== 'euipo-normalized' || rawData.version !== EUIPO_RAW_DATA_VERSION) {
    return null;
  }

  const trademark = typeof rawData.trademark === 'object' && rawData.trademark !== null
    ? rawData.trademark as Record<string, unknown>
    : {};
  const context = typeof rawData.context === 'object' && rawData.context !== null ? rawData.context as Record<string, unknown> : {};
  const analysis = typeof rawData.analysis === 'object' && rawData.analysis !== null ? rawData.analysis as Record<string, unknown> : {};

  return stripUndefinedDeep({
    kind: 'euipo-normalized',
    version: EUIPO_RAW_DATA_VERSION,
    trademark: {
      applicationNumber: typeof trademark.applicationNumber === 'string' ? trademark.applicationNumber : '',
      markName: typeof trademark.markName === 'string' ? trademark.markName : '',
      applicantName: typeof trademark.applicantName === 'string' ? trademark.applicantName : undefined,
      niceClasses: typeof trademark.niceClasses === 'string' ? trademark.niceClasses : undefined,
      status: typeof trademark.status === 'string' ? trademark.status : undefined,
      filingDate: typeof trademark.filingDate === 'string' ? trademark.filingDate : undefined,
      registrationDate: typeof trademark.registrationDate === 'string' ? trademark.registrationDate : undefined,
      expiryDate: typeof trademark.expiryDate === 'string' ? trademark.expiryDate : undefined,
      markType: typeof trademark.markType === 'string' ? trademark.markType : undefined,
      markKind: typeof trademark.markKind === 'string' ? trademark.markKind : undefined,
      markBasis: typeof trademark.markBasis === 'string' ? trademark.markBasis : undefined,
      representativeName: typeof trademark.representativeName === 'string' ? trademark.representativeName : undefined,
      goodsAndServicesDescription: typeof trademark.goodsAndServicesDescription === 'string' ? trademark.goodsAndServicesDescription : undefined,
      renewalStatus: typeof trademark.renewalStatus === 'string' ? trademark.renewalStatus : undefined,
      markImageUrl: typeof trademark.markImageUrl === 'string' ? trademark.markImageUrl : undefined,
      euipoUrl: typeof trademark.euipoUrl === 'string' ? trademark.euipoUrl : '',
      extractedAt: typeof trademark.extractedAt === 'string' ? trademark.extractedAt : undefined,
    },
    context: {
      sourceQueries: Array.isArray(context.sourceQueries)
        ? context.sourceQueries.filter((value): value is string => typeof value === 'string')
        : [],
      dateFrom: typeof context.dateFrom === 'string' ? context.dateFrom : undefined,
      dateTo: typeof context.dateTo === 'string' ? context.dateTo : undefined,
      maxResults: typeof context.maxResults === 'number' ? context.maxResults : undefined,
      observedStatuses: Array.isArray(context.observedStatuses)
        ? context.observedStatuses.filter((value): value is string => typeof value === 'string')
        : [],
      observedApplicants: Array.isArray(context.observedApplicants)
        ? context.observedApplicants.filter((value): value is string => typeof value === 'string')
        : [],
      observedNiceClasses: Array.isArray(context.observedNiceClasses)
        ? context.observedNiceClasses.filter((value): value is string => typeof value === 'string')
        : [],
      sampleMarkNames: Array.isArray(context.sampleMarkNames)
        ? context.sampleMarkNames.filter((value): value is string => typeof value === 'string')
        : [],
    },
    analysis: {
      source: analysis.source === 'fallback' ? 'fallback' : 'llm',
      runId: typeof analysis.runId === 'string' ? analysis.runId : '',
      findingSource: isKnownFindingSource(analysis.findingSource) ? analysis.findingSource : 'euipo',
      scannerId: isKnownScannerId(analysis.scannerId) ? analysis.scannerId : 'euipo-trademarks',
      searchDepth: typeof analysis.searchDepth === 'number' ? analysis.searchDepth : 0,
      searchQuery: typeof analysis.searchQuery === 'string' ? analysis.searchQuery : undefined,
      displayQuery: typeof analysis.displayQuery === 'string' ? analysis.displayQuery : undefined,
    },
  });
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
    ...(typeof sighting.position === 'number' ? { position: sighting.position } : {}),
    title: sighting.title,
    ...(typeof sighting.displayedUrl === 'string' ? { displayedUrl: sighting.displayedUrl } : {}),
    ...(typeof sighting.description === 'string' ? { description: sighting.description } : {}),
    ...(Array.isArray(sighting.emphasizedKeywords)
      ? {
        emphasizedKeywords: sighting.emphasizedKeywords.filter((entry): entry is string => typeof entry === 'string'),
      }
      : {}),
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
    || value === 'telegram'
    || value === 'apple_app_store'
    || value === 'google_play'
    || value === 'domains'
    || value === 'discord'
    || value === 'github'
    || value === 'euipo'
    || value === 'x'
    || value === 'unknown'
  );
}

function isKnownScannerId(value: unknown): value is ActorRunInfo['scannerId'] {
  return (
    value === 'google-web'
    || value === 'google-reddit'
    || value === 'reddit-posts'
    || value === 'tiktok-posts'
    || value === 'google-youtube'
    || value === 'google-facebook'
    || value === 'google-instagram'
    || value === 'google-telegram'
    || value === 'google-apple-app-store'
    || value === 'google-play'
    || value === 'domain-registrations'
    || value === 'discord-servers'
    || value === 'github-repos'
    || value === 'euipo-trademarks'
    || value === 'x-search'
  );
}

function isKnownGoogleScannerId(value: unknown): value is GoogleScannerId {
  return (
    value === 'google-web'
    || value === 'google-reddit'
    || value === 'google-youtube'
    || value === 'google-facebook'
    || value === 'google-instagram'
    || value === 'google-telegram'
    || value === 'google-apple-app-store'
    || value === 'google-play'
  );
}

function resolveScannerConfig(actorRunInfo?: Partial<ActorRunInfo>): ScannerConfig {
  if (actorRunInfo?.scannerId && isKnownScannerId(actorRunInfo.scannerId)) {
    return getScannerConfigById(actorRunInfo.scannerId);
  }

  if (actorRunInfo?.source === 'reddit') {
    if (actorRunInfo.actorId === GOOGLE_SEARCH_ACTOR_ID) {
      return getScannerConfigById('google-reddit');
    }
    if (actorRunInfo.actorId === REDDIT_POST_SCRAPER_ACTOR_ID) {
      return getScannerConfigById('reddit-posts');
    }
  }

  if (actorRunInfo?.source === 'tiktok' && actorRunInfo.actorId === TIKTOK_POST_SCRAPER_ACTOR_ID) {
    return getScannerConfigById('tiktok-posts');
  }

  if (
    actorRunInfo?.source === 'reddit'
    || actorRunInfo?.source === 'tiktok'
    || actorRunInfo?.source === 'youtube'
    || actorRunInfo?.source === 'facebook'
    || actorRunInfo?.source === 'instagram'
    || actorRunInfo?.source === 'telegram'
    || actorRunInfo?.source === 'apple_app_store'
    || actorRunInfo?.source === 'google_play'
    || actorRunInfo?.source === 'domains'
    || actorRunInfo?.source === 'google'
    || actorRunInfo?.source === 'discord'
    || actorRunInfo?.source === 'github'
    || actorRunInfo?.source === 'euipo'
    || actorRunInfo?.source === 'x'
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
      || source === 'telegram'
      || source === 'apple_app_store'
      || source === 'google_play'
      || source === 'domains'
      || source === 'discord'
      || source === 'github'
      || source === 'euipo'
      || source === 'x'
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
    theme: existing.provisionalTheme ?? existing.theme,
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

function choosePreferredRedditOutcome(existing: Finding | null, next: RedditFindingOutcome): RedditFindingOutcome {
  if (!existing) return next;

  const existingSource = readRedditStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: RedditFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
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

function choosePreferredTikTokOutcome(existing: Finding | null, next: TikTokFindingOutcome): TikTokFindingOutcome {
  if (!existing) return next;

  const existingSource = readTikTokStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: TikTokFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
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
    theme: existing.provisionalTheme ?? existing.theme,
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

function choosePreferredDomainRegistrationOutcome(
  existing: Finding | null,
  next: DomainRegistrationFindingOutcome,
): DomainRegistrationFindingOutcome {
  if (!existing) return next;

  const existingSource = readDomainRegistrationStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: DomainRegistrationFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
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

function choosePreferredXOutcome(existing: Finding | null, next: XFindingOutcome): XFindingOutcome {
  if (!existing) return next;

  const existingRawData = readXStoredFindingRawData(existing.rawData);
  const existingSource = existingRawData?.analysis.source ?? 'llm';
  const existingOutcome: XFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
    analysis: existing.llmAnalysis,
    isFalsePositive: existing.isFalsePositive === true,
    matchBasis: existing.xMatchBasis ?? existingRawData?.analysis.matchBasis ?? 'none',
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

function choosePreferredGitHubOutcome(existing: Finding | null, next: GitHubFindingOutcome): GitHubFindingOutcome {
  if (!existing) return next;

  const existingSource = readGitHubStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: GitHubFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
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

function choosePreferredEuipoOutcome(existing: Finding | null, next: EuipoFindingOutcome): EuipoFindingOutcome {
  if (!existing) return next;

  const existingSource = readEuipoStoredFindingRawData(existing.rawData)?.analysis.source ?? 'llm';
  const existingOutcome: EuipoFindingOutcome = {
    severity: existing.severity,
    title: existing.title,
    theme: existing.provisionalTheme ?? existing.theme,
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

async function finalizeScanWithSummary(scanRef: DocumentReference, summaryResult: BuiltScanAiSummaryResult) {
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
      aiSummary: summaryResult.summary,
      completedAt: FieldValue.serverTimestamp(),
      summaryStartedAt: FieldValue.delete(),
      ...(typeof summaryResult.rawLlmResponse === 'string'
        ? { scanSummaryRawLlmResponse: summaryResult.rawLlmResponse }
        : fresh.scanSummaryRawLlmResponse
          ? { scanSummaryRawLlmResponse: FieldValue.delete() }
          : {}),
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

  try {
    const brandDoc = await db.collection('brands').doc(fresh.brandId).get();
    const brandName = brandDoc.exists ? (brandDoc.data() as BrandProfile).name : undefined;
    await normalizeAndPersistScanThemes({
      scanId: fresh.id,
      brandId: fresh.brandId,
      userId: fresh.userId,
      brandName,
    });
  } catch (err) {
    console.error(`[webhook] Theme normalization failed for scan ${fresh.id}:`, err);
  }

  let summaryResult: BuiltScanAiSummaryResult;
  try {
    summaryResult = await buildScanAiSummary(fresh);
  } catch (err) {
    console.error(`[webhook] Unexpected scan summary build error for scan ${fresh.id}:`, err);
    summaryResult = { summary: buildCountOnlyScanAiSummary(fresh) };
  }

  await finalizeScanWithSummary(scanRef, summaryResult);
  try {
    await rebuildAndPersistDashboardBreakdownsForScanIds({
      brandId: fresh.brandId,
      userId: fresh.userId,
      scanIds: [fresh.id],
    });
  } catch (err) {
    console.error(`[webhook] Failed to persist dashboard breakdowns for scan ${fresh.id}:`, err);
  }
  await sendCompletedScanSummaryEmailIfNeeded(scanRef);

  try {
    await markDashboardExecutiveSummaryPending({
      brandId: fresh.brandId,
      requestedForScanId: fresh.id,
    });
    await scheduleDashboardExecutiveSummaryTaskOrRunInline({
      payload: {
        kind: 'dashboard-executive-summary',
        brandId: fresh.brandId,
        userId: fresh.userId,
      },
      requestHeaders: new Headers(),
      logPrefix: `[dashboard-executive-summary] Completed scan ${fresh.id}`,
      runInline: () => generateAndPersistDashboardExecutiveSummary({
        brandId: fresh.brandId,
        userId: fresh.userId,
      }),
    });
  } catch (err) {
    console.error(`[webhook] Failed to schedule dashboard executive summary for scan ${fresh.id}:`, err);
  }
}

function normalizeSuggestedSearchKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildGoogleFindingId(scanId: string, normalizedUrl: string): string {
  return `${GOOGLE_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${normalizedUrl}`).digest('hex')}`;
}

function buildRedditFindingId(scanId: string, postId: string): string {
  return `${REDDIT_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${postId}`).digest('hex')}`;
}

function buildTikTokFindingId(scanId: string, videoId: string): string {
  return `${TIKTOK_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${videoId}`).digest('hex')}`;
}

function buildDiscordFindingId(scanId: string, serverId: string): string {
  return `${DISCORD_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${serverId}`).digest('hex')}`;
}

function buildDomainRegistrationFindingId(scanId: string, domain: string): string {
  return `${DOMAIN_REGISTRATION_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${domain.toLowerCase()}`).digest('hex')}`;
}

function buildXFindingId(scanId: string, tweetId: string): string {
  return `${X_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${tweetId}`).digest('hex')}`;
}

function buildGitHubFindingId(scanId: string, fullName: string): string {
  return `${GITHUB_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${fullName.toLowerCase()}`).digest('hex')}`;
}

function buildEuipoFindingId(scanId: string, applicationNumber: string): string {
  return `${EUIPO_FINDING_ID_PREFIX}-${createHash('sha256').update(`${scanId}:${applicationNumber}`).digest('hex')}`;
}

function normalizeStoredCanonicalId(canonicalId: unknown, options?: { lowerCase?: boolean }): string | null {
  if (typeof canonicalId !== 'string') {
    return null;
  }

  const trimmed = canonicalId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return options?.lowerCase ? trimmed.toLowerCase() : trimmed;
}

function normalizeRedditPostUrl(url: string): string | null {
  const absoluteUrl = url.startsWith('/') ? `https://www.reddit.com${url}` : url;
  const permalink = extractRedditPermalinkParts(absoluteUrl);
  if (permalink) {
    return permalink.canonicalUrl;
  }

  return normalizeUrlForFinding(absoluteUrl);
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

function readRedditPostId(item: Record<string, unknown>): string | null {
  const id = readOptionalTrimmedString(item.id);
  return id && id.length > 0 ? id : null;
}

function readRedditCanonicalUrl(item: Record<string, unknown>): string | null {
  const candidates = [
    readOptionalTrimmedString(item.canonical_url),
    readOptionalTrimmedString(item.url),
    readOptionalTrimmedString(item.permalink),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const value of candidates) {
    const normalized = normalizeRedditPostUrl(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function readTikTokVideoId(item: Record<string, unknown>): string | null {
  const candidates = [item.aweme_id, item.id, item.videoId];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readTikTokVideoUrl(item: Record<string, unknown>): string | null {
  const directCandidates = [
    readOptionalTrimmedString(item.postPage),
    readOptionalTrimmedString(item.webVideoUrl),
    readOptionalTrimmedString(item.shareUrl),
    readOptionalTrimmedString(item.url),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const value of directCandidates) {
    const normalized = normalizeUrlForFinding(value);
    if (normalized && /:\/\/(?:www\.)?tiktok\.com\//i.test(normalized)) {
      return normalized;
    }
  }

  const videoId = readTikTokVideoId(item);
  const author = readTikTokAuthor(item);
  if (!videoId || !author.uniqueId) {
    return null;
  }

  return normalizeUrlForFinding(`https://www.tiktok.com/@${author.uniqueId}/video/${videoId}`);
}

function readTikTokCaption(item: Record<string, unknown>): string | undefined {
  return readOptionalTrimmedString(item.desc)
    ?? readOptionalTrimmedString(item.title)
    ?? readOptionalTrimmedString(item.description);
}

function readTikTokCreatedAt(item: Record<string, unknown>): string | undefined {
  const formatted = readOptionalTrimmedString(item.uploadedAtFormatted) ?? readOptionalTrimmedString(item.createTimeISO);
  if (formatted) {
    const parsed = Date.parse(formatted);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  const numericCandidate = readOptionalFiniteNumber(item.uploadedAt)
    ?? readOptionalFiniteNumber(item.createTime)
    ?? readOptionalFiniteNumber(item.create_time);
  if (numericCandidate === undefined) {
    return undefined;
  }

  const milliseconds = numericCandidate > 1_000_000_000_000 ? numericCandidate : numericCandidate * 1000;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function readTikTokAuthor(item: Record<string, unknown>): TikTokVideoCandidate['author'] {
  const author = typeof item.author === 'object' && item.author !== null
    ? item.author as Record<string, unknown>
    : (typeof item.channel === 'object' && item.channel !== null
      ? item.channel as Record<string, unknown>
      : {});

  const uniqueId = readOptionalTrimmedString(author.unique_id)
    ?? readOptionalTrimmedString(author.uniqueId)
    ?? readOptionalTrimmedString(author.username)
    ?? readOptionalTrimmedString(author.name)
    ?? readOptionalTrimmedString(item['author.unique_id'])
    ?? readOptionalTrimmedString(item['author.uniqueId'])
    ?? readOptionalTrimmedString(item['author.username'])
    ?? readOptionalTrimmedString(item['author.name'])
    ?? readOptionalTrimmedString(item['channel.unique_id'])
    ?? readOptionalTrimmedString(item['channel.uniqueId'])
    ?? readOptionalTrimmedString(item['channel.username'])
    ?? readOptionalTrimmedString(item['channel.name']);
  const url = readOptionalTrimmedString(author.url)
    ?? readOptionalTrimmedString(item['author.url'])
    ?? readOptionalTrimmedString(item['channel.url'])
    ?? (uniqueId ? `https://www.tiktok.com/@${uniqueId}` : undefined);
  const id = readOptionalTrimmedString(author.user_id)
    ?? readOptionalTrimmedString(author.id)
    ?? readOptionalTrimmedString(item['author.user_id'])
    ?? readOptionalTrimmedString(item['author.id'])
    ?? readOptionalTrimmedString(item['channel.id']);
  const nickname = readOptionalTrimmedString(author.nickname)
    ?? readOptionalTrimmedString(item['author.nickname'])
    ?? readOptionalTrimmedString(item['channel.name']);
  const signature = readOptionalTrimmedString(author.signature)
    ?? readOptionalTrimmedString(author.bio)
    ?? readOptionalTrimmedString(item['author.signature'])
    ?? readOptionalTrimmedString(item['author.bio'])
    ?? readOptionalTrimmedString(item['channel.signature'])
    ?? readOptionalTrimmedString(item['channel.bio']);
  const verified = typeof author.verified === 'boolean'
    ? author.verified
    : (typeof item['author.verified'] === 'boolean'
      ? item['author.verified']
      : (typeof item['channel.verified'] === 'boolean' ? item['channel.verified'] : undefined));

  return {
    ...(id ? { id } : {}),
    ...(uniqueId ? { uniqueId } : {}),
    ...(nickname ? { nickname } : {}),
    ...(signature ? { signature } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(url ? { url } : {}),
  };
}

function readTikTokHashtags(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.hashtags)) return [];

  return uniqueStrings(
    item.hashtags
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim().replace(/^#/, '');
        if (typeof entry === 'object' && entry !== null) {
          const objectEntry = entry as Record<string, unknown>;
          return readOptionalTrimmedString(objectEntry.name)
            ?? readOptionalTrimmedString(objectEntry.hashtagName)
            ?? readOptionalTrimmedString(objectEntry.title)
            ?? '';
        }
        return '';
      })
      .map((value) => value.replace(/^#/, '').trim())
      .filter((value) => value.length > 0),
  );
}

function readTikTokMentions(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.mentions)) return [];

  return uniqueStrings(
    item.mentions
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim().replace(/^@/, '');
        if (typeof entry === 'object' && entry !== null) {
          const objectEntry = entry as Record<string, unknown>;
          return readOptionalTrimmedString(objectEntry.unique_id)
            ?? readOptionalTrimmedString(objectEntry.uniqueId)
            ?? readOptionalTrimmedString(objectEntry.username)
            ?? readOptionalTrimmedString(objectEntry.name)
            ?? '';
        }
        return '';
      })
      .map((value) => value.replace(/^@/, '').trim())
      .filter((value) => value.length > 0),
  );
}

function readTikTokMusic(item: Record<string, unknown>): TikTokVideoCandidate['music'] | undefined {
  const music = typeof item.music === 'object' && item.music !== null
    ? item.music as Record<string, unknown>
    : (typeof item.song === 'object' && item.song !== null
      ? item.song as Record<string, unknown>
      : null);
  if (!music) {
    return undefined;
  }

  const idValue = music.id;
  const id = typeof idValue === 'string'
    ? idValue.trim()
    : (typeof idValue === 'number' && Number.isFinite(idValue) ? String(idValue) : undefined)
    ?? readOptionalTrimmedString(item['music.id'])
    ?? readOptionalTrimmedString(item['song.id']);
  const title = readOptionalTrimmedString(music.title)
    ?? readOptionalTrimmedString(item['music.title'])
    ?? readOptionalTrimmedString(item['song.title']);
  const author = readOptionalTrimmedString(music.author)
    ?? readOptionalTrimmedString(music.artist)
    ?? readOptionalTrimmedString(item['music.author'])
    ?? readOptionalTrimmedString(item['music.artist'])
    ?? readOptionalTrimmedString(item['song.author'])
    ?? readOptionalTrimmedString(item['song.artist']);
  const ownerHandle = readOptionalTrimmedString(music.owner_handle)
    ?? readOptionalTrimmedString(item['music.owner_handle'])
    ?? readOptionalTrimmedString(item['song.owner_handle']);
  const isOriginalSound = typeof music.is_original_sound === 'boolean'
    ? music.is_original_sound
    : (typeof music.isOriginalSound === 'boolean'
      ? music.isOriginalSound
      : (typeof item['music.is_original_sound'] === 'boolean'
        ? item['music.is_original_sound']
        : (typeof item['song.is_original_sound'] === 'boolean' ? item['song.is_original_sound'] : undefined)));

  if (!id && !title && !author && !ownerHandle && isOriginalSound === undefined) {
    return undefined;
  }

  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(isOriginalSound !== undefined ? { isOriginalSound } : {}),
  };
}

function readTikTokStats(item: Record<string, unknown>): TikTokVideoCandidate['stats'] {
  const statistics = typeof item.statistics === 'object' && item.statistics !== null
    ? item.statistics as Record<string, unknown>
    : {};

  return {
    ...(readOptionalFiniteNumber(statistics.play_count ?? item.views) !== undefined
      ? { playCount: readOptionalFiniteNumber(statistics.play_count ?? item.views) }
      : {}),
    ...(readOptionalFiniteNumber(statistics.digg_count ?? item.likes) !== undefined
      ? { diggCount: readOptionalFiniteNumber(statistics.digg_count ?? item.likes) }
      : {}),
    ...(readOptionalFiniteNumber(statistics.comment_count ?? item.comments) !== undefined
      ? { commentCount: readOptionalFiniteNumber(statistics.comment_count ?? item.comments) }
      : {}),
    ...(readOptionalFiniteNumber(statistics.share_count ?? item.shares) !== undefined
      ? { shareCount: readOptionalFiniteNumber(statistics.share_count ?? item.shares) }
      : {}),
    ...(readOptionalFiniteNumber(statistics.collect_count ?? item.bookmarks) !== undefined
      ? { collectCount: readOptionalFiniteNumber(statistics.collect_count ?? item.bookmarks) }
      : {}),
  };
}

function readTikTokMatchedQuery(item: Record<string, unknown>): string | undefined {
  return readOptionalTrimmedString(item.searchKeyword)
    ?? readOptionalTrimmedString(item.searchQuery)
    ?? readOptionalTrimmedString(item.query)
    ?? readOptionalTrimmedString(item.keyword);
}

function mergeTikTokAuthors(
  existing?: TikTokVideoCandidate['author'],
  next?: TikTokVideoCandidate['author'],
): TikTokVideoCandidate['author'] {
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    ...(next?.id ? { id: next.id } : {}),
    ...(existing?.uniqueId ? { uniqueId: existing.uniqueId } : {}),
    ...(next?.uniqueId ? { uniqueId: next.uniqueId } : {}),
    ...(existing?.nickname ? { nickname: existing.nickname } : {}),
    ...(next?.nickname ? { nickname: next.nickname } : {}),
    ...(existing?.signature ? { signature: existing.signature } : {}),
    ...(next?.signature ? { signature: next.signature } : {}),
    ...(existing?.verified !== undefined ? { verified: existing.verified } : {}),
    ...(next?.verified !== undefined ? { verified: next.verified } : {}),
    ...(existing?.url ? { url: existing.url } : {}),
    ...(next?.url ? { url: next.url } : {}),
  };
}

function mergeTikTokMusic(
  existing?: TikTokVideoCandidate['music'],
  next?: TikTokVideoCandidate['music'],
): TikTokVideoCandidate['music'] | undefined {
  if (!existing && !next) {
    return undefined;
  }

  return {
    ...(existing?.id ? { id: existing.id } : {}),
    ...(next?.id ? { id: next.id } : {}),
    ...(existing?.title ? { title: existing.title } : {}),
    ...(next?.title ? { title: next.title } : {}),
    ...(existing?.author ? { author: existing.author } : {}),
    ...(next?.author ? { author: next.author } : {}),
    ...(existing?.ownerHandle ? { ownerHandle: existing.ownerHandle } : {}),
    ...(next?.ownerHandle ? { ownerHandle: next.ownerHandle } : {}),
    ...(existing?.isOriginalSound !== undefined ? { isOriginalSound: existing.isOriginalSound } : {}),
    ...(next?.isOriginalSound !== undefined ? { isOriginalSound: next.isOriginalSound } : {}),
  };
}

function mergeTikTokStats(
  existing?: TikTokVideoCandidate['stats'],
  next?: TikTokVideoCandidate['stats'],
): TikTokVideoCandidate['stats'] {
  return {
    ...(existing?.playCount !== undefined ? { playCount: existing.playCount } : {}),
    ...(next?.playCount !== undefined ? { playCount: next.playCount } : {}),
    ...(existing?.diggCount !== undefined ? { diggCount: existing.diggCount } : {}),
    ...(next?.diggCount !== undefined ? { diggCount: next.diggCount } : {}),
    ...(existing?.commentCount !== undefined ? { commentCount: existing.commentCount } : {}),
    ...(next?.commentCount !== undefined ? { commentCount: next.commentCount } : {}),
    ...(existing?.shareCount !== undefined ? { shareCount: existing.shareCount } : {}),
    ...(next?.shareCount !== undefined ? { shareCount: next.shareCount } : {}),
    ...(existing?.collectCount !== undefined ? { collectCount: existing.collectCount } : {}),
    ...(next?.collectCount !== undefined ? { collectCount: next.collectCount } : {}),
  };
}

function readDiscordServerId(item: Record<string, unknown>): string | null {
  const candidateIds = [item.id, item.objectID];
  for (const value of candidateIds) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readDelimitedQueries(value?: string): string[] {
  if (!value) return [];
  return uniqueStrings(
    value
      .split('|')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function readDiscordSourceQueries(value?: string): string[] {
  return readDelimitedQueries(value);
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

function readDomainRegistrationDomain(item: Record<string, unknown>): string | null {
  const value = readOptionalTrimmedString(item.domain);
  if (!value) return null;
  return normalizeDomainRegistrationDomain(value);
}

function normalizeDomainRegistrationDomain(value: string): string | null {
  const normalized = value.trim().replace(/\.+$/, '').toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes(' ')) {
    return null;
  }
  return normalized;
}

function extractTldFromDomain(domain: string): string {
  const parts = domain.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function buildDomainRegistrationUrl(domain: string): string {
  return `https://${domain}/`;
}

function readDomainRegistrationRequestMetadata(value: unknown): {
  selectedDate?: string;
  dateComparison?: string;
  totalLimit?: number;
  sortField?: string;
  sortOrder?: string;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const metadata = value as Record<string, unknown>;
  return {
    selectedDate: readOptionalTrimmedString(metadata.selectedDate),
    dateComparison: readOptionalTrimmedString(metadata.dateComparison),
    totalLimit: readOptionalFiniteNumber(metadata.totalLimit),
    sortField: readOptionalTrimmedString(metadata.sortField),
    sortOrder: readOptionalTrimmedString(metadata.sortOrder),
  };
}

function readDomainRegistrationResponseMetadata(value: unknown): {
  sortField?: string;
  sortOrder?: string;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const metadata = value as Record<string, unknown>;
  return {
    sortField: readOptionalTrimmedString(metadata.sortField),
    sortOrder: readOptionalTrimmedString(metadata.sortOrder),
  };
}

function readDomainRegistrationEnhancedAnalysis(
  value: unknown,
): DomainRegistrationCandidate['enhancedAnalysis'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const analysis = value as Record<string, unknown>;
  const status = readOptionalTrimmedString(analysis.status);
  if (!status) return undefined;

  return {
    status,
    ...(readOptionalTrimmedString(analysis.model) ? { model: readOptionalTrimmedString(analysis.model) } : {}),
    ...(readOptionalTrimmedString(analysis.sourceUrl) ? { sourceUrl: readOptionalTrimmedString(analysis.sourceUrl) } : {}),
    ...(readOptionalTrimmedString(analysis.finalUrl) ? { finalUrl: readOptionalTrimmedString(analysis.finalUrl) } : {}),
    ...(readOptionalTrimmedString(analysis.summary) ? { summary: readOptionalTrimmedString(analysis.summary) } : {}),
    ...(readOptionalFiniteNumber(analysis.extractedTextLength) !== undefined
      ? { extractedTextLength: readOptionalFiniteNumber(analysis.extractedTextLength) }
      : {}),
    ...(readOptionalTrimmedString(analysis.failureReason) ? { failureReason: readOptionalTrimmedString(analysis.failureReason) } : {}),
    ...(readOptionalTrimmedString(analysis.errorMessage) ? { errorMessage: readOptionalTrimmedString(analysis.errorMessage) } : {}),
    ...(readOptionalTrimmedString(analysis.contentType) ? { contentType: readOptionalTrimmedString(analysis.contentType) } : {}),
  };
}

function readGitHubRepoFullName(item: Record<string, unknown>): string | null {
  const value = readOptionalTrimmedString(item.fullName) ?? readOptionalTrimmedString(item.full_name);
  if (!value || !value.includes('/')) {
    return null;
  }
  const [owner, repo] = splitGitHubFullName(value);
  if (!owner || !repo) {
    return null;
  }
  return `${owner}/${repo}`;
}

function buildGitHubRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

function splitGitHubFullName(fullName: string): [string, string] {
  const [owner, ...rest] = fullName.split('/');
  const repo = rest.join('/').trim();
  return [owner?.trim() ?? '', repo];
}

function readEuipoApplicationNumber(item: Record<string, unknown>): string | null {
  return readOptionalTrimmedString(item.applicationNumber) ?? null;
}

function readEuipoUrl(item: Record<string, unknown>, applicationNumber: string): string {
  const providedUrl = readOptionalTrimmedString(item.euipoUrl);
  return providedUrl ?? `https://euipo.europa.eu/eSearch/#basic/1+1+1+1/50+50+50+50/${applicationNumber}`;
}

function readXTweetId(item: Record<string, unknown>): string | null {
  const candidateIds = [item.id];
  for (const value of candidateIds) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readXUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const normalized = normalizeUrlForFinding(value.trim());
  return normalized ?? undefined;
}

function readXAuthor(value: unknown): XTweetCandidate['author'] {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const author = value as Record<string, unknown>;
  return {
    ...(typeof author.id === 'string' && author.id.trim().length > 0 ? { id: author.id.trim() } : {}),
    ...(typeof author.userName === 'string' && author.userName.trim().length > 0 ? { userName: author.userName.trim() } : {}),
    ...(typeof author.name === 'string' && author.name.trim().length > 0 ? { name: author.name.trim() } : {}),
    ...(readXUrl(author.url) ? { url: readXUrl(author.url)! } : {}),
    ...(readXUrl(author.twitterUrl) ? { twitterUrl: readXUrl(author.twitterUrl)! } : {}),
    ...(typeof author.isVerified === 'boolean' ? { isVerified: author.isVerified } : {}),
    ...(typeof author.isBlueVerified === 'boolean' ? { isBlueVerified: author.isBlueVerified } : {}),
    ...(typeof author.verifiedType === 'string' && author.verifiedType.trim().length > 0 ? { verifiedType: author.verifiedType.trim() } : {}),
    ...(readOptionalFiniteNumber(author.followers) !== undefined ? { followers: readOptionalFiniteNumber(author.followers) } : {}),
    ...(readOptionalFiniteNumber(author.following) !== undefined ? { following: readOptionalFiniteNumber(author.following) } : {}),
  };
}

function buildXAccountKey({
  authorId,
  authorHandle,
}: {
  authorId?: string;
  authorHandle?: string;
}): string | null {
  const trimmedId = authorId?.trim();
  if (trimmedId) {
    return `id:${trimmedId}`;
  }

  const trimmedHandle = authorHandle?.trim().toLowerCase();
  if (trimmedHandle) {
    return `handle:${trimmedHandle}`;
  }

  return null;
}

function isXFindingMatchBasis(value: unknown): value is XFindingMatchBasis {
  return value === 'none'
    || value === 'handle_only'
    || value === 'content_only'
    || value === 'handle_and_content';
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

function trimToLength(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeVerifiedRedditCommentSnapshot(value: unknown): VerifiedRedditCommentSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const comment = value as Record<string, unknown>;
  const id = readOptionalTrimmedString(comment.id);
  const body = readOptionalTrimmedString(comment.body);
  if (!id || !body) {
    return undefined;
  }

  return {
    id,
    body,
    ...(readOptionalTrimmedString(comment.author) ? { author: readOptionalTrimmedString(comment.author) } : {}),
    ...(readOptionalFiniteNumber(comment.score) !== undefined ? { score: readOptionalFiniteNumber(comment.score) } : {}),
    ...(readOptionalFiniteNumber(comment.depth) !== undefined ? { depth: readOptionalFiniteNumber(comment.depth) } : {}),
  };
}

function normalizeVerifiedRedditPostSnapshot(value: unknown): VerifiedRedditPostSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const snapshot = value as Record<string, unknown>;
  const source = readOptionalTrimmedString(snapshot.source);
  const canonicalUrl = readOptionalTrimmedString(snapshot.canonicalUrl);
  const jsonUrl = readOptionalTrimmedString(snapshot.jsonUrl);
  const postId = readOptionalTrimmedString(snapshot.postId);
  const subreddit = readOptionalTrimmedString(snapshot.subreddit);
  const title = readOptionalTrimmedString(snapshot.title);
  if (source !== 'reddit-json' || !canonicalUrl || !jsonUrl || !postId || !subreddit || !title) {
    return undefined;
  }

  return {
    source: 'reddit-json',
    canonicalUrl,
    jsonUrl,
    postId,
    subreddit,
    title,
    ...(readOptionalTrimmedString(snapshot.selftext) ? { selftext: readOptionalTrimmedString(snapshot.selftext) } : {}),
    ...(readOptionalTrimmedString(snapshot.author) ? { author: readOptionalTrimmedString(snapshot.author) } : {}),
    ...(readOptionalTrimmedString(snapshot.permalink) ? { permalink: readOptionalTrimmedString(snapshot.permalink) } : {}),
    ...(readOptionalFiniteNumber(snapshot.createdUtc) !== undefined ? { createdUtc: readOptionalFiniteNumber(snapshot.createdUtc) } : {}),
    ...(readOptionalFiniteNumber(snapshot.score) !== undefined ? { score: readOptionalFiniteNumber(snapshot.score) } : {}),
    ...(readOptionalFiniteNumber(snapshot.numComments) !== undefined ? { numComments: readOptionalFiniteNumber(snapshot.numComments) } : {}),
    ...(readOptionalTrimmedString(snapshot.linkFlairText) ? { linkFlairText: readOptionalTrimmedString(snapshot.linkFlairText) } : {}),
    ...(typeof snapshot.isSelfPost === 'boolean' ? { isSelfPost: snapshot.isSelfPost } : {}),
    ...(readOptionalTrimmedString(snapshot.domain) ? { domain: readOptionalTrimmedString(snapshot.domain) } : {}),
    ...(typeof snapshot.over18 === 'boolean' ? { over18: snapshot.over18 } : {}),
    ...(normalizeVerifiedRedditCommentSnapshot(snapshot.matchedComment)
      ? { matchedComment: normalizeVerifiedRedditCommentSnapshot(snapshot.matchedComment) }
      : {}),
  };
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

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined)
      .map((entry) => stripUndefinedDeep(entry)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)]),
  ) as T;
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
    if (!freshSnap.exists) {
      console.log(`[webhook] markActorRunComplete: scan ${scanDoc.id} no longer exists — skipping`);
      return { needsSummary: false };
    }

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
    const allDone = updatedCompletedCount >= totalRunCount && !hasQueuedActorLaunchWork(fresh);
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
    return {
      needsSummary: allDone && updates.status === 'summarising',
    };
  });

  if (result.needsSummary) {
    await generateAndPersistScanSummary(scanDoc.ref);
  }
}
