import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { fetchDatasetItems, startDeepSearchRun } from '@/lib/apify/client';
import { getActorConfig } from '@/lib/apify/actors';
import { chatCompletion } from '@/lib/analysis/openrouter';
import { SYSTEM_PROMPT, BATCH_SYSTEM_PROMPT, buildAnalysisPrompt, buildBatchAnalysisPrompt } from '@/lib/analysis/prompts';
import { parseAnalysisOutput, parseBatchAnalysisOutput, MAX_SUGGESTED_SEARCHES } from '@/lib/analysis/types';
import type { PerPageFinding } from '@/lib/analysis/types';
import type { BrandProfile, Finding, Scan, ActorRunInfo } from '@/lib/types';
import { clearBrandActiveScanIfMatches } from '@/lib/scans';

/** Maximum items to analyse per actor run — caps AI analysis cost and latency */
const MAX_ITEMS_PER_RUN = 50;

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
      ignoredUrls,
    });
    newFindingCount = findingCount;
    counts.high = batchCounts.high;
    counts.medium = batchCounts.medium;
    counts.low = batchCounts.low;
    counts.nonHit = batchCounts.nonHit;

    // Trigger deep follow-up searches if AI analysis requested them and this is a depth-0 run
    if (suggestedSearches && suggestedSearches.length > 0 && searchDepth === 0) {
      await triggerDeepSearches({
        scanDoc,
        scan,
        suggestedSearches,
        webhookUrl,
        source,
        actorId: 'apify/google-search-scraper',
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
  ignoredUrls?: string[];
}): Promise<{ findingCount: number; suggestedSearches?: string[]; counts: { high: number; medium: number; low: number; nonHit: number } }> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;
  const counts = { high: 0, medium: 0, low: 0, nonHit: 0 };

  // All pages stored together on every Finding so the full raw dataset is always
  // accessible from any individual result card.
  const sharedRawData = { pages: items, pageCount: items.length };

  try {
    const analysisResult = await analyseItemBatch({
      brand,
      source,
      actorId,
      items,
      canSuggestSearches: searchDepth === 0,
      ignoredUrls,
    });

    suggestedSearches = analysisResult.suggestedSearches;

    // Write one Firestore Finding per assessed search result
    const writeOps = analysisResult.perPageFindings.map(async (pageItem: PerPageFinding) => {
      const findingRef = db.collection('findings').doc();
      const finding: Omit<Finding, 'id'> = {
        scanId: scan.id ?? scanDoc.id,
        brandId: scan.brandId,
        userId: scan.userId,
        source,
        actorId,
        severity: pageItem.severity,
        title: pageItem.title,
        description: pageItem.analysis,
        llmAnalysis: pageItem.analysis,
        url: pageItem.url || undefined,
        rawData: sharedRawData,
        isFalsePositive: pageItem.isFalsePositive,
        // Auto-ignore AI-classified false positives so their URLs are excluded
        // from future scans. Users can un-ignore them if needed.
        ...(pageItem.isFalsePositive && {
          isIgnored: true,
          ignoredAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        }),
        rawLlmResponse: analysisResult.rawLlmResponse,
        createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
      };
      await findingRef.set(finding);
      return pageItem;
    });

    const written = await Promise.all(writeOps);
    for (const pageItem of written) {
      if (pageItem.isFalsePositive) {
        counts.nonHit++;
      } else {
        findingCount++;
        if (pageItem.severity === 'high') counts.high++;
        else if (pageItem.severity === 'medium') counts.medium++;
        else if (pageItem.severity === 'low') counts.low++;
      }
    }
  } catch (err) {
    console.error(`[webhook] Batch AI analysis failed for dataset ${datasetId}:`, err);
    const findingRef = db.collection('findings').doc();
    const fallbackFinding: Omit<Finding, 'id'> = {
      scanId: scan.id ?? scanDoc.id,
      brandId: scan.brandId,
      userId: scan.userId,
      source,
      actorId,
      severity: 'medium',
      title: 'Unanalysed result — review manually',
      description: 'AI analysis failed for this batch. Raw data is preserved for manual review.',
      llmAnalysis: 'AI analysis failed for this batch. Raw data is preserved for manual review.',
      url: extractUrl(items[0] ?? {}),
      rawData: sharedRawData,
      isFalsePositive: false,
      createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
    };
    await findingRef.set(fallbackFinding);
    findingCount++;
    counts.medium++;
  }

  // Mark all SERP pages as analysed at once (batch mode resolves in one AI analysis call)
  await scanDoc.ref.update({
    [`actorRuns.${runId}.analysedCount`]: items.length,
  });

  return { findingCount, suggestedSearches, counts };
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
  suggestedSearches,
  webhookUrl,
  source,
  actorId,
}: {
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
  suggestedSearches: string[];
  webhookUrl: string;
  source: Finding['source'];
  actorId: string;
}) {
  const queries = suggestedSearches.slice(0, MAX_SUGGESTED_SEARCHES);
  console.log(`[webhook] Triggering ${queries.length} deep search(es) for scan ${scanDoc.id}:`, queries);

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
        searchDepth: 1,
        searchQuery: query,
      };
      console.log(`[webhook] Started deep search for "${query}" → runId=${runId}`);
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

/**
 * Run all SERP pages from an actor run through AI analysis in one batch call.
 * Returns a per-result assessment for every individual organic/paid search result,
 * plus the raw AI response string and any suggested follow-up searches.
 */
async function analyseItemBatch({
  brand,
  source,
  actorId,
  items,
  canSuggestSearches,
  ignoredUrls,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  actorId: string;
  items: Record<string, unknown>[];
  canSuggestSearches?: boolean;
  ignoredUrls?: string[];
}): Promise<{ perPageFindings: PerPageFinding[]; rawLlmResponse: string; suggestedSearches?: string[] }> {
  void actorId;
  const prompt = buildBatchAnalysisPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
    safeWords: brand.safeWords,
    ignoredUrls,
    source,
    rawItems: items,
    canSuggestSearches,
  });

  const raw = await chatCompletion([
    { role: 'system', content: BATCH_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseBatchAnalysisOutput(raw);
  if (!parsed) {
    throw new Error(`Failed to parse batch AI analysis output: ${raw.slice(0, 200)}`);
  }

  return {
    perPageFindings: parsed.items,
    rawLlmResponse: raw,
    suggestedSearches: parsed.suggestedSearches,
  };
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
