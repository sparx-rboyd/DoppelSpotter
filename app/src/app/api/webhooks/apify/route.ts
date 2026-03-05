import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { fetchDatasetItems, startDeepSearchRun } from '@/lib/apify/client';
import { getActorConfig } from '@/lib/apify/actors';
import { chatCompletion } from '@/lib/analysis/openrouter';
import {
  SYSTEM_PROMPT,
  GOOGLE_CLASSIFICATION_SYSTEM_PROMPT,
  GOOGLE_SUGGESTION_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildGoogleChunkAnalysisPrompt,
  buildGoogleSuggestionPrompt,
} from '@/lib/analysis/prompts';
import {
  parseAnalysisOutput,
  parseGoogleChunkAnalysisOutput,
  parseGoogleSuggestionOutput,
  MAX_SUGGESTED_SEARCHES,
  type GoogleChunkAnalysisItem,
  type GoogleRunContext,
  type GoogleSearchCandidate,
  type GoogleSearchSighting,
  type GoogleStoredFindingRawData,
} from '@/lib/analysis/types';
import type { BrandProfile, Finding, Scan, ActorRunInfo } from '@/lib/types';
import { normalizeAllowAiDeepSearches } from '@/lib/brands';
import { clearBrandActiveScanIfMatches } from '@/lib/scans';

/** Maximum items to analyse per actor run — caps AI analysis cost and latency */
const MAX_ITEMS_PER_RUN = 50;
const GOOGLE_ANALYSIS_CHUNK_SIZE = 10;
const MAX_GOOGLE_CONTEXT_RELATED_QUERIES = 20;
const MAX_GOOGLE_CONTEXT_PEOPLE_ALSO_ASK = 20;
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

function logGoogleDebug(event: string, details: Record<string, unknown>) {
  console.log(`[webhook][google] ${event}`, details);
}

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
    await handleSucceededRun({
      runId: resource.id,
      datasetId: resource.defaultDatasetId,
      scanDoc,
      scan,
      webhookUrl,
    });
  } else if (resource.status === 'FAILED' || resource.status === 'ABORTED') {
    console.warn(`[webhook] Actor run ${resource.id} ended with status: ${resource.status}`);
    await markActorRunComplete(scanDoc, resource.id, 'failed');
  }

  return NextResponse.json({ received: true });
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

  // Phase 1 → Phase 2: signal that we are now retrieving the Apify dataset
  await scanDoc.ref.update({ [`actorRuns.${runId}.status`]: 'fetching_dataset' });

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
  });

  const actorConfig = getActorConfig(actorId);
  const analysisMode = actorConfig?.analysisMode ?? 'per-item';

  if (analysisMode === 'batch' || source === 'google' || actorId === 'apify/google-search-scraper') {
    logGoogleDebug('run-start', {
      scanId: scanDoc.id,
      runId,
      actorId,
      source,
      searchDepth,
      searchQuery: searchQuery ?? null,
      datasetId,
      fetchedItemCount: items.length,
      analysedItemCount: itemsToAnalyse.length,
      ignoredUrlCount: ignoredUrls.length,
      allowAiDeepSearches: normalizeAllowAiDeepSearches(brand.allowAiDeepSearches),
      googleResultsLimit: brand.googleResultsLimit ?? null,
    });
  }

  let newFindingCount = 0;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };

  if (analysisMode === 'batch') {
    // Send all SERP pages to AI analysis in one call → one Finding per individual search result
    const { findingCount, suggestedSearches, counts: batchCounts } = await analyseAndWriteBatch({
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
    });
    newFindingCount = findingCount;
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
      });
      if (reservedQueries.length > 0) {
        await triggerDeepSearches({
          scanDoc,
          scan,
          brand,
          suggestedSearches: reservedQueries,
          webhookUrl,
          source,
          actorId: 'apify/google-search-scraper',
        });
      }
    } else if (analysisMode === 'batch' || source === 'google' || actorId === 'apify/google-search-scraper') {
      logGoogleDebug('deep-search-not-triggered', {
        scanId: scanDoc.id,
        runId,
        searchDepth,
        allowAiDeepSearches: normalizeAllowAiDeepSearches(brand.allowAiDeepSearches),
        suggestedSearches: suggestedSearches ?? [],
      });
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
    `[webhook] Actor ${actorId} (run ${runId}, depth ${searchDepth}): ${newFindingCount} findings written from ${itemsToAnalyse.length} items (mode: ${analysisMode})`,
  );

  await markActorRunComplete(scanDoc, runId, 'succeeded', newFindingCount, counts);
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
}): Promise<{ findingCount: number; suggestedSearches?: string[]; counts: { high: number; medium: number; low: number; nonHit: number } }> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  const canSuggestSearches = searchDepth === 0 && normalizeAllowAiDeepSearches(brand.allowAiDeepSearches);

  const normalizedRun = normalizeGoogleSerpRun({
    runId,
    searchDepth,
    searchQuery,
    items,
  });

  logGoogleDebug('normalized-run', {
    scanId: scanDoc.id,
    runId,
    searchDepth,
    searchQuery: searchQuery ?? null,
    candidateCount: normalizedRun.candidates.length,
    sourceQueries: normalizedRun.runContext.sourceQueries,
    relatedQueryCount: normalizedRun.runContext.relatedQueries.length,
    relatedQueriesSample: normalizedRun.runContext.relatedQueries.slice(0, 5),
    peopleAlsoAskCount: normalizedRun.runContext.peopleAlsoAsk.length,
    peopleAlsoAskSample: normalizedRun.runContext.peopleAlsoAsk.slice(0, 5),
    canSuggestSearches,
  });

  await scanDoc.ref.update({
    [`actorRuns.${runId}.itemCount`]: normalizedRun.candidates.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
  });

  const outcomes = new Map<string, { candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>();
  const suggestionScores = new Map<string, SuggestedSearchScore>();
  const chunks = chunkArray(normalizedRun.candidates, GOOGLE_ANALYSIS_CHUNK_SIZE);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    logGoogleDebug('chunk-start', {
      scanId: scanDoc.id,
      runId,
      chunkIndex: chunkIndex + 1,
      chunkCount: chunks.length,
      candidateCount: chunk.length,
      candidateUrls: chunk.map((candidate) => candidate.normalizedUrl).slice(0, 10),
    });
    try {
      const chunkResult = await analyseGoogleChunk({
        brand,
        source,
        candidates: chunk,
        runContext: normalizedRun.runContext,
        ignoredUrls,
        canSuggestSearches,
      });
      for (const [normalizedUrl, value] of chunkResult.outcomes.entries()) {
        outcomes.set(normalizedUrl, value);
      }
      if (canSuggestSearches && chunkResult.suggestedSearches && chunkResult.suggestedSearches.length > 0) {
        scoreSuggestedSearches({
          scores: suggestionScores,
          suggestedSearches: chunkResult.suggestedSearches,
          chunkOutcomes: chunkResult.outcomes.values(),
          sourceQueries: normalizedRun.runContext.sourceQueries,
        });
      }
      logGoogleDebug('chunk-complete', {
        scanId: scanDoc.id,
        runId,
        chunkIndex: chunkIndex + 1,
        chunkCount: chunks.length,
        counts: summarizeGoogleOutcomeCounts(chunkResult.outcomes.values()),
        suggestedSearches: chunkResult.suggestedSearches ?? [],
      });
    } catch (err) {
      console.error(`[webhook] Google chunk analysis failed for dataset ${datasetId} (chunk ${chunkIndex + 1}/${chunks.length}):`, err);
      for (const candidate of chunk) {
        outcomes.set(candidate.normalizedUrl, {
          candidate,
          outcome: buildGoogleFallbackOutcome('AI analysis failed for this chunk. Raw data is preserved for manual review.'),
        });
      }
      logGoogleDebug('chunk-failed', {
        scanId: scanDoc.id,
        runId,
        chunkIndex: chunkIndex + 1,
        chunkCount: chunks.length,
        fallbackCandidateUrls: chunk.map((candidate) => candidate.normalizedUrl).slice(0, 10),
      });
    }

    await scanDoc.ref.update({
      [`actorRuns.${runId}.analysedCount`]: FieldValue.increment(chunk.length),
    });
  }

  const chunkRankedSuggestions = canSuggestSearches ? rankSuggestedSearches(suggestionScores) : undefined;
  if (canSuggestSearches) {
    logGoogleDebug('chunk-suggestions-ranked', {
      scanId: scanDoc.id,
      runId,
      rankedSuggestions: chunkRankedSuggestions ?? [],
      suggestionScores: Array.from(suggestionScores.values())
        .sort((left, right) => right.score - left.score || right.mentionCount - left.mentionCount)
        .slice(0, 10),
    });
  }

  if (canSuggestSearches && (hasGoogleSuggestionSignals(normalizedRun.runContext) || (chunkRankedSuggestions?.length ?? 0) > 0)) {
    try {
      const aggregateSuggestedSearches = await analyseGoogleSuggestions({
        brand,
        source,
        runContext: normalizedRun.runContext,
        notableCandidates: buildGoogleSuggestionNotableCandidates(outcomes.values()),
        chunkSuggestedSearches: chunkRankedSuggestions,
      });

      logGoogleDebug('aggregate-suggestions', {
        scanId: scanDoc.id,
        runId,
        aggregateSuggestedSearches: aggregateSuggestedSearches ?? [],
      });

      if (aggregateSuggestedSearches && aggregateSuggestedSearches.length > 0) {
        scoreSuggestedSearches({
          scores: suggestionScores,
          suggestedSearches: aggregateSuggestedSearches,
          chunkOutcomes: outcomes.values(),
          sourceQueries: normalizedRun.runContext.sourceQueries,
        });
      }
    } catch (err) {
      console.error(`[webhook] Google aggregate suggestion analysis failed for dataset ${datasetId}:`, err);
    }
  } else if (canSuggestSearches) {
    logGoogleDebug('aggregate-suggestions-skipped', {
      scanId: scanDoc.id,
      runId,
      hasRunContextSignals: hasGoogleSuggestionSignals(normalizedRun.runContext),
      chunkSuggestionCount: chunkRankedSuggestions?.length ?? 0,
    });
  }

  if (canSuggestSearches) {
    suggestedSearches = rankSuggestedSearches(suggestionScores);
    logGoogleDebug('final-suggestions', {
      scanId: scanDoc.id,
      runId,
      suggestedSearches: suggestedSearches ?? [],
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

  logGoogleDebug('batch-complete', {
    scanId: scanDoc.id,
    runId,
    findingCount,
    counts,
    suggestedSearches: suggestedSearches ?? [],
  });

  return { findingCount, suggestedSearches, counts };
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
  suggestedSearches?: string[];
};

type SuggestedSearchScore = {
  query: string;
  mentionCount: number;
  score: number;
  maxSeverityRank: number;
};

type FindingDelta = {
  findingCount: number;
  counts: { high: number; medium: number; low: number; nonHit: number };
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
      relatedQueries: uniqueStrings(Array.from(relatedQueries)).slice(0, MAX_GOOGLE_CONTEXT_RELATED_QUERIES),
      peopleAlsoAsk: uniqueStrings(Array.from(peopleAlsoAsk)).slice(0, MAX_GOOGLE_CONTEXT_PEOPLE_ALSO_ASK),
    },
  };
}

async function analyseGoogleChunk({
  brand,
  source,
  candidates,
  runContext,
  ignoredUrls,
  canSuggestSearches,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  candidates: GoogleSearchCandidate[];
  runContext: GoogleRunContext;
  ignoredUrls?: string[];
  canSuggestSearches: boolean;
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
    canSuggestSearches,
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

  return {
    outcomes,
    suggestedSearches: canSuggestSearches ? parsed.suggestedSearches : undefined,
  };
}

async function analyseGoogleSuggestions({
  brand,
  source,
  runContext,
  notableCandidates,
  chunkSuggestedSearches,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  runContext: GoogleRunContext;
  notableCandidates: Array<Record<string, unknown>>;
  chunkSuggestedSearches?: string[];
}): Promise<string[] | undefined> {
  const prompt = buildGoogleSuggestionPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    source,
    runContext,
    notableCandidates,
    chunkSuggestedSearches,
  });

  const raw = await chatCompletion([
    { role: 'system', content: GOOGLE_SUGGESTION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseGoogleSuggestionOutput(raw);
  if (!parsed) {
    throw new Error(`Failed to parse Google suggestion output: ${raw.slice(0, 200)}`);
  }

  return parsed.suggestedSearches;
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
        rawLlmResponse: preferredOutcome.rawLlmResponse,
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
      rawLlmResponse: preferredOutcome.rawLlmResponse ?? existing.rawLlmResponse,
    };

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
}: {
  scanDoc: QueryDocumentSnapshot;
  runId: string;
  suggestedSearches: string[];
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
      .slice(0, MAX_SUGGESTED_SEARCHES);

    logGoogleDebug('reserve-suggestions', {
      scanId: scanDoc.id,
      runId,
      requestedSuggestions: suggestedSearches,
      existingQueries: Array.from(existingQueries),
      reservedSuggestions: reserved,
    });

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
 * Caps total deep searches at MAX_SUGGESTED_SEARCHES (enforced by the parser already,
 * but guarded here too). Adds the new runs to the scan document atomically so that
 * markActorRunComplete can correctly detect overall scan completion.
 */
async function triggerDeepSearches({
  scanDoc,
  scan,
  brand,
  suggestedSearches,
  webhookUrl,
  source,
  actorId,
}: {
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
  brand: BrandProfile;
  suggestedSearches: string[];
  webhookUrl: string;
  source: Finding['source'];
  actorId: string;
}) {
  const queries = suggestedSearches.slice(0, MAX_SUGGESTED_SEARCHES);
  logGoogleDebug('trigger-deep-searches', {
    scanId: scanDoc.id,
    brandId: scan.brandId,
    googleResultsLimit: brand.googleResultsLimit ?? null,
    queryCount: queries.length,
    queries,
  });

  const newRunIds: string[] = [];
  const newActorRuns: Record<string, ActorRunInfo> = {};

  for (const query of queries) {
    try {
      const { runId } = await startDeepSearchRun(query, webhookUrl, brand.googleResultsLimit);
      newRunIds.push(runId);
      newActorRuns[runId] = {
        actorId,
        source,
        status: 'running',
        searchDepth: 1,
        searchQuery: query,
      };
      logGoogleDebug('deep-search-started', {
        scanId: scanDoc.id,
        query,
        runId,
      });
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

function hasGoogleSuggestionSignals(runContext: GoogleRunContext): boolean {
  return runContext.relatedQueries.length > 0 || runContext.peopleAlsoAsk.length > 0;
}

function summarizeGoogleOutcomeCounts(
  values: Iterable<{ candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>,
) {
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };
  for (const { outcome } of values) {
    if (outcome.isFalsePositive) {
      counts.nonHit++;
      continue;
    }
    if (outcome.severity === 'high') counts.high++;
    else if (outcome.severity === 'medium') counts.medium++;
    else counts.low++;
  }
  return counts;
}

function buildGoogleSuggestionNotableCandidates(
  values: Iterable<{ candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>,
): Array<Record<string, unknown>> {
  return Array.from(values)
    .map(({ candidate, outcome }) => ({
      resultId: candidate.resultId,
      url: candidate.normalizedUrl,
      title: candidate.title,
      description: candidate.description,
      pageNumbers: candidate.pageNumbers,
      positions: candidate.positions,
      appearanceCount: candidate.sightings.length,
      severity: outcome.severity,
      isFalsePositive: outcome.isFalsePositive,
      analysis: outcome.analysis,
    }))
    .sort((left, right) =>
      Number(Boolean(right.isFalsePositive === false)) - Number(Boolean(left.isFalsePositive === false))
      || getSeverityRank(String(right.severity) as Finding['severity']) - getSeverityRank(String(left.severity) as Finding['severity'])
      || String(left.url).localeCompare(String(right.url)),
    )
    .slice(0, 12);
}

function scoreSuggestedSearches({
  scores,
  suggestedSearches,
  chunkOutcomes,
  sourceQueries,
}: {
  scores: Map<string, SuggestedSearchScore>;
  suggestedSearches: string[];
  chunkOutcomes: Iterable<{ candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>;
  sourceQueries: string[];
}) {
  const sourceQueryKeys = new Set(sourceQueries.map(normalizeSuggestedSearchKey));
  const chunkSeverityRank = getChunkSuggestionSeverityRank(chunkOutcomes);
  const chunkWeight = Math.max(chunkSeverityRank, 1);

  for (const suggestedSearch of suggestedSearches) {
    const normalizedQuery = suggestedSearch.trim().replace(/\s+/g, ' ');
    if (!normalizedQuery) continue;

    const key = normalizeSuggestedSearchKey(normalizedQuery);
    if (!key || sourceQueryKeys.has(key)) continue;

    const existing = scores.get(key);
    if (existing) {
      existing.mentionCount += 1;
      existing.score += chunkWeight;
      existing.maxSeverityRank = Math.max(existing.maxSeverityRank, chunkSeverityRank);
      continue;
    }

    scores.set(key, {
      query: normalizedQuery,
      mentionCount: 1,
      score: chunkWeight,
      maxSeverityRank: chunkSeverityRank,
    });
  }
}

function rankSuggestedSearches(scores: Map<string, SuggestedSearchScore>): string[] | undefined {
  const ranked = Array.from(scores.values())
    .sort((left, right) =>
      right.score - left.score
      || right.mentionCount - left.mentionCount
      || right.maxSeverityRank - left.maxSeverityRank
      || left.query.localeCompare(right.query),
    )
    .slice(0, MAX_SUGGESTED_SEARCHES)
    .map((entry) => entry.query);

  return ranked.length > 0 ? ranked : undefined;
}

function getChunkSuggestionSeverityRank(
  chunkOutcomes: Iterable<{ candidate: GoogleSearchCandidate; outcome: GoogleFindingOutcome }>,
): number {
  let maxRank = 0;
  for (const { outcome } of chunkOutcomes) {
    if (outcome.isFalsePositive) continue;
    maxRank = Math.max(maxRank, getSeverityRank(outcome.severity));
  }
  return maxRank;
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
) {
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    const fresh = freshSnap.data() as Scan;

    // If the scan was cancelled (e.g. user cancelled while this run was being processed),
    // do not overwrite the cancelled status or increment completion counters.
    if (fresh.status === 'cancelled') {
      console.log(`[webhook] markActorRunComplete: scan ${scanDoc.id} is cancelled — skipping`);
      return;
    }

    const existingRunStatus = fresh.actorRuns?.[runId]?.status;
    if (existingRunStatus === 'succeeded' || existingRunStatus === 'failed') {
      console.log(`[webhook] markActorRunComplete: run ${runId} already ${existingRunStatus} — skipping duplicate completion`);
      return;
    }

    // Read the current total from the fresh snapshot so any deep-search runs
    // added after the scan started are included in the completion check.
    const totalRunCount = fresh.actorRunIds?.length ?? 1;
    const updatedCompletedCount = (fresh.completedRunCount ?? 0) + 1;
    const allDone = updatedCompletedCount >= totalRunCount;

    const updates: Record<string, unknown> = {
      [`actorRuns.${runId}.status`]: runStatus,
      completedRunCount: FieldValue.increment(1),
      findingCount: FieldValue.increment(newFindingCount),
      highCount: FieldValue.increment(newCounts.high),
      mediumCount: FieldValue.increment(newCounts.medium),
      lowCount: FieldValue.increment(newCounts.low),
      nonHitCount: FieldValue.increment(newCounts.nonHit),
    };

    if (allDone) {
      // Determine overall scan outcome: completed if at least one actor succeeded
      const actorRuns = fresh.actorRuns ?? {};
      const anySucceeded =
        runStatus === 'succeeded' ||
        Object.values(actorRuns).some((r) => r.status === 'succeeded');

      updates.status = anySucceeded ? 'completed' : 'failed';
      updates.completedAt = FieldValue.serverTimestamp();

      if (!anySucceeded) {
        updates.errorMessage = 'All actor runs failed or were aborted';
      }

      console.log(`[webhook] Scan ${scanDoc.id} is complete — status: ${updates.status}`);

      await clearBrandActiveScanIfMatches(db.collection('brands').doc(fresh.brandId), scanDoc.id, tx);
    }

    tx.update(scanDoc.ref, updates);
  });
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
