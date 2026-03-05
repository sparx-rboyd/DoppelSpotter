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

/** Maximum items to analyse per actor run — caps LLM cost and latency */
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
 * Handle a succeeded actor run: fetch dataset items, run LLM analysis on each,
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
  // Fetch the brand profile for context in the LLM prompt
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

  // Cap items to control LLM cost
  const itemsToAnalyse = items.slice(0, MAX_ITEMS_PER_RUN);
  if (items.length > MAX_ITEMS_PER_RUN) {
    console.warn(
      `[webhook] Dataset ${datasetId} has ${items.length} items — truncating to ${MAX_ITEMS_PER_RUN}`,
    );
  }

  // Phase 2 → Phase 3: signal that LLM analysis is starting, and record total item count
  await scanDoc.ref.update({
    [`actorRuns.${runId}.status`]: 'analysing',
    [`actorRuns.${runId}.itemCount`]: itemsToAnalyse.length,
    [`actorRuns.${runId}.analysedCount`]: 0,
  });

  const actorConfig = getActorConfig(actorId);
  const analysisMode = actorConfig?.analysisMode ?? 'per-item';

  let newFindingCount = 0;

  if (analysisMode === 'batch') {
    // Send all SERP pages to the LLM in one call → one Finding per individual search result
    const { findingCount, suggestedSearches } = await analyseAndWriteBatch({
      scanDoc,
      scan,
      brand,
      source,
      actorId,
      datasetId,
      runId,
      items: itemsToAnalyse,
      searchDepth,
    });
    newFindingCount = findingCount;

    // Trigger deep follow-up searches if the LLM requested them and this is a depth-0 run
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
        const analysisResult = await analyseItem({ brand, source, actorId, item });
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
          rawLlmResponse: analysisResult.rawLlmResponse,
          createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        };
        await findingRef.set(finding);
        if (!analysisResult.isFalsePositive) {
          newFindingCount++;
        }
      } catch (err) {
        // On LLM failure, write a fallback finding so no data is silently lost
        console.error(`[webhook] LLM analysis failed for item in dataset ${datasetId}:`, err);
        const findingRef = db.collection('findings').doc();
        const fallbackFinding: Omit<Finding, 'id'> = {
          scanId: scan.id ?? scanDoc.id,
          brandId: scan.brandId,
          userId: scan.userId,
          source,
          actorId,
          severity: 'medium',
          title: 'Unanalysed result — review manually',
          description: 'LLM analysis failed for this item. Raw data is preserved for manual review.',
          llmAnalysis: 'LLM analysis failed for this item. Raw data is preserved for manual review.',
          url: extractUrl(item),
          rawData: item,
          isFalsePositive: false,
          createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
        };
        await findingRef.set(fallbackFinding);
        newFindingCount++;
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

  await markActorRunComplete(scanDoc, runId, 'succeeded', newFindingCount);
}

/**
 * Batch mode: send all SERP pages to the LLM in one call, then write one Finding
 * per individual search result the LLM assessed. Returns the count of non-false-positive
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
}): Promise<{ findingCount: number; suggestedSearches?: string[] }> {
  let findingCount = 0;
  let suggestedSearches: string[] | undefined;

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
        rawLlmResponse: analysisResult.rawLlmResponse,
        createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
      };
      await findingRef.set(finding);
      return pageItem.isFalsePositive ? 0 : 1;
    });

    const counts = await Promise.all(writeOps);
    findingCount = counts.reduce((sum, c) => sum + c, 0);
  } catch (err) {
    console.error(`[webhook] Batch LLM analysis failed for dataset ${datasetId}:`, err);
    const findingRef = db.collection('findings').doc();
    const fallbackFinding: Omit<Finding, 'id'> = {
      scanId: scan.id ?? scanDoc.id,
      brandId: scan.brandId,
      userId: scan.userId,
      source,
      actorId,
      severity: 'medium',
      title: 'Unanalysed result — review manually',
      description: 'LLM analysis failed for this batch. Raw data is preserved for manual review.',
      llmAnalysis: 'LLM analysis failed for this batch. Raw data is preserved for manual review.',
      url: extractUrl(items[0] ?? {}),
      rawData: sharedRawData,
      isFalsePositive: false,
      createdAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
    };
    await findingRef.set(fallbackFinding);
    findingCount++;
  }

  // Mark all SERP pages as analysed at once (batch mode resolves in one LLM call)
  await scanDoc.ref.update({
    [`actorRuns.${runId}.analysedCount`]: items.length,
  });

  return { findingCount, suggestedSearches };
}

/**
 * Start follow-up Google Search actor runs for each query suggested by the LLM.
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
 * Run a single dataset item through the LLM for classification.
 * Returns parsed fields plus the raw LLM response string for storage / debugging.
 */
async function analyseItem({
  brand,
  source,
  actorId,
  item,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  actorId: string;
  item: Record<string, unknown>;
}): Promise<{ severity: Finding['severity']; title: string; llmAnalysis: string; isFalsePositive: boolean; rawLlmResponse: string }> {
  void actorId;
  const prompt = buildAnalysisPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
    source,
    rawData: item,
  });

  const raw = await chatCompletion([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const parsed = parseAnalysisOutput(raw);
  if (!parsed) {
    throw new Error(`Failed to parse LLM output: ${raw.slice(0, 200)}`);
  }

  return { ...parsed, rawLlmResponse: raw };
}

/**
 * Run all SERP pages from an actor run through the LLM in one batch call.
 * Returns a per-result assessment for every individual organic/paid search result,
 * plus the raw LLM response string and any suggested follow-up searches.
 */
async function analyseItemBatch({
  brand,
  source,
  actorId,
  items,
  canSuggestSearches,
}: {
  brand: BrandProfile;
  source: Finding['source'];
  actorId: string;
  items: Record<string, unknown>[];
  canSuggestSearches?: boolean;
}): Promise<{ perPageFindings: PerPageFinding[]; rawLlmResponse: string; suggestedSearches?: string[] }> {
  void actorId;
  const prompt = buildBatchAnalysisPrompt({
    brandName: brand.name,
    keywords: brand.keywords,
    officialDomains: brand.officialDomains,
    watchWords: brand.watchWords,
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
    throw new Error(`Failed to parse batch LLM output: ${raw.slice(0, 200)}`);
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
) {
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    const fresh = freshSnap.data() as Scan;

    // Read the current total from the fresh snapshot so any deep-search runs
    // added after the scan started are included in the completion check.
    const totalRunCount = fresh.actorRunIds?.length ?? 1;
    const updatedCompletedCount = (fresh.completedRunCount ?? 0) + 1;
    const allDone = updatedCompletedCount >= totalRunCount;

    const updates: Record<string, unknown> = {
      [`actorRuns.${runId}.status`]: runStatus,
      completedRunCount: FieldValue.increment(1),
      findingCount: FieldValue.increment(newFindingCount),
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
