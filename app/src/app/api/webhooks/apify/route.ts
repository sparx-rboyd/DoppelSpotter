import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { fetchDatasetItems } from '@/lib/apify/client';
import { chatCompletion } from '@/lib/analysis/openrouter';
import { SYSTEM_PROMPT, buildAnalysisPrompt } from '@/lib/analysis/prompts';
import { parseAnalysisOutput } from '@/lib/analysis/types';
import type { BrandProfile, Finding, Scan } from '@/lib/types';

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

  if (resource.status === 'SUCCEEDED') {
    await handleSucceededRun({
      runId: resource.id,
      datasetId: resource.defaultDatasetId,
      scanDoc,
      scan,
    });
  } else if (resource.status === 'FAILED' || resource.status === 'ABORTED') {
    console.warn(`[webhook] Actor run ${resource.id} ended with status: ${resource.status}`);
    await markActorRunComplete(scanDoc, scan, resource.id, 'failed');
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
}: {
  runId: string;
  datasetId: string;
  scanDoc: QueryDocumentSnapshot;
  scan: Scan;
}) {
  // Fetch the brand profile for context in the LLM prompt
  const brandDoc = await db.collection('brands').doc(scan.brandId).get();
  if (!brandDoc.exists) {
    console.error(`[webhook] Brand ${scan.brandId} not found for scan ${scanDoc.id}`);
    await markActorRunComplete(scanDoc, scan, runId, 'failed');
    return;
  }
  const brand = brandDoc.data() as BrandProfile;

  // Determine the source (surface) for this actor run
  const actorRunInfo = scan.actorRuns?.[runId];
  const source = actorRunInfo?.source ?? 'unknown';
  const actorId = actorRunInfo?.actorId ?? 'unknown';

  // Fetch raw scraping results from Apify's dataset
  let items: Record<string, unknown>[];
  try {
    items = await fetchDatasetItems(datasetId);
  } catch (err) {
    console.error(`[webhook] Failed to fetch dataset ${datasetId}:`, err);
    await markActorRunComplete(scanDoc, scan, runId, 'failed');
    return;
  }

  if (items.length === 0) {
    console.log(`[webhook] No items in dataset ${datasetId} for actor ${actorId}`);
    await markActorRunComplete(scanDoc, scan, runId, 'succeeded');
    return;
  }

  // Cap items to control LLM cost
  const itemsToAnalyse = items.slice(0, MAX_ITEMS_PER_RUN);
  if (items.length > MAX_ITEMS_PER_RUN) {
    console.warn(
      `[webhook] Dataset ${datasetId} has ${items.length} items — truncating to ${MAX_ITEMS_PER_RUN}`,
    );
  }

  // Analyse each item sequentially to avoid rate-limiting OpenRouter
  let newFindingCount = 0;
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
  }

  console.log(
    `[webhook] Actor ${actorId} (run ${runId}): ${newFindingCount} findings written from ${itemsToAnalyse.length} items`,
  );

  await markActorRunComplete(scanDoc, scan, runId, 'succeeded', newFindingCount);
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
 * Use a Firestore transaction to atomically mark an actor run as complete,
 * increment completedRunCount, update findingCount, and — if all runs are
 * now done — set the overall scan status to 'completed' or 'failed'.
 */
async function markActorRunComplete(
  scanDoc: QueryDocumentSnapshot,
  scan: Scan,
  runId: string,
  runStatus: 'succeeded' | 'failed',
  newFindingCount = 0,
) {
  const totalRunCount = scan.actorRunIds?.length ?? 1;

  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(scanDoc.ref);
    const fresh = freshSnap.data() as Scan;

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
