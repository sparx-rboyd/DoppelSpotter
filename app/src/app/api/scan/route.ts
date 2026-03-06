import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import type { BrandProfile, Scan, ActorRunInfo } from '@/lib/types';
import { abortActorRun } from '@/lib/apify/client';
import { clearBrandActiveScanIfMatches, isScanInProgress, scanFromSnapshot } from '@/lib/scans';

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

class ActiveScanConflictError extends Error {
  constructor(public readonly scan: Scan) {
    super('Brand already has a scan in progress');
  }
}

// POST /api/scan — trigger a scan for a brand
// Body: { brandId: string; actorIds?: string[] }
export async function POST(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  let body: { brandId: string; actorIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { brandId, actorIds } = body;
  if (!brandId) return errorResponse('brandId is required');

  const brandRef = db.collection('brands').doc(brandId);

  // Determine which actors to run — default to all core actors
  const { CORE_ACTOR_IDS, getActorConfig } = await import('@/lib/apify/actors');
  const { startActorRun } = await import('@/lib/apify/client');

  const targetActorIds = actorIds ?? CORE_ACTOR_IDS;

  // Create a scan record with status 'pending' first so we have a scanId
  const scanRef = db.collection('scans').doc();
  const scan: Omit<Scan, 'id'> = {
    brandId,
    userId: uid,
    status: 'pending',
    actorIds: targetActorIds,
    actorRunIds: [],
    actorRuns: {},
    completedRunCount: 0,
    findingCount: 0,
    skippedCount: 0,
    startedAt: FieldValue.serverTimestamp() as unknown as import('@google-cloud/firestore').Timestamp,
  };

  let brand: BrandProfile | null = null;

  try {
    await db.runTransaction(async (tx) => {
      const brandDoc = await tx.get(brandRef);
      if (!brandDoc.exists) throw new HttpError('Brand not found', 404);

      const brandData = brandDoc.data() as BrandProfile;
      if (brandData.userId !== uid) throw new HttpError('Forbidden', 403);

      const activeScanId = brandData.activeScanId;
      if (activeScanId) {
        const activeScanDoc = await tx.get(db.collection('scans').doc(activeScanId));
        if (activeScanDoc.exists) {
          const activeScan = scanFromSnapshot(activeScanDoc);
          if (
            activeScan.brandId === brandId &&
            activeScan.userId === uid &&
            isScanInProgress(activeScan.status)
          ) {
            throw new ActiveScanConflictError(activeScan);
          }
        }

        tx.update(brandRef, { activeScanId: FieldValue.delete() });
      }

      brand = brandData;
      tx.set(scanRef, scan);
      tx.update(brandRef, { activeScanId: scanRef.id });
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.message, err.status);
    }

    if (err instanceof ActiveScanConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          code: 'ACTIVE_SCAN_EXISTS',
          data: { activeScan: err.scan },
        },
        { status: 409 },
      );
    }

    throw err;
  }

  if (!brand) {
    return errorResponse('Failed to prepare scan', 500);
  }

  // Build the webhook URL — must be publicly reachable (use APP_URL env var)
  const appUrl = buildAppUrl(request);
  const webhookUrl = `${appUrl}/api/webhooks/apify`;

  // Start each actor asynchronously; collect run IDs as they start
  const actorRunIds: string[] = [];
  const actorRuns: Record<string, ActorRunInfo> = {};
  let successCount = 0;

  for (const actorId of targetActorIds) {
    const actorConfig = getActorConfig(actorId);
    if (!actorConfig) {
      console.warn(`[scan] Unknown actor ID: ${actorId} — skipping`);
      continue;
    }

    try {
      const { runId } = await startActorRun(actorConfig, brand, webhookUrl);
      actorRunIds.push(runId);
      actorRuns[runId] = {
        actorId,
        source: actorConfig.source,
        status: 'running',
        skippedDuplicateCount: 0,
      };
      successCount++;
      console.log(`[scan] Started actor ${actorId} → runId=${runId}`);
    } catch (err) {
      console.error(`[scan] Failed to start actor ${actorId}:`, err);
    }
  }

  // If every actor failed to start, mark the scan as failed immediately
  if (successCount === 0) {
    await scanRef.update({
      status: 'failed',
      errorMessage: 'All actor runs failed to start',
      completedAt: FieldValue.serverTimestamp(),
    });
    await clearBrandActiveScanIfMatches(brandRef, scanRef.id);
    return errorResponse('Failed to start any actor runs', 500);
  }

  // Update scan with run IDs and set status to 'running'
  await scanRef.update({
    status: 'running',
    actorRunIds,
    actorRuns,
    // If some actors failed to start, pre-count them as completed so the
    // webhook handler can still detect overall scan completion correctly.
    completedRunCount: targetActorIds.length - successCount,
  });

  return NextResponse.json(
    { data: { scanId: scanRef.id, status: 'running', actorCount: successCount } },
    { status: 202 },
  );
}

// GET /api/scan?scanId=xxx — poll scan status
export async function GET(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const scanId = request.nextUrl.searchParams.get('scanId');
  if (!scanId) return errorResponse('scanId query param is required');

  const scanDoc = await db.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) return errorResponse('Scan not found', 404);

  const scan = scanDoc.data() as Omit<Scan, 'id'>;
  if (scan.userId !== uid) return errorResponse('Forbidden', 403);

  return NextResponse.json({ data: { id: scanDoc.id, ...scan } });
}

// DELETE /api/scan?scanId=xxx — cancel an in-progress scan
export async function DELETE(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const scanId = request.nextUrl.searchParams.get('scanId');
  if (!scanId) return errorResponse('scanId query param is required');

  const scanDoc = await db.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) return errorResponse('Scan not found', 404);

  const scan = scanDoc.data() as Scan;
  if (scan.userId !== uid) return errorResponse('Forbidden', 403);

  if (scan.status !== 'pending' && scan.status !== 'running') {
    return errorResponse('Scan is not in progress', 409);
  }

  let runIds: string[] = [];

  // Mark the scan cancelled first so any in-flight webhook callbacks are ignored
  try {
    await db.runTransaction(async (tx) => {
      const freshScanDoc = await tx.get(scanDoc.ref);
      if (!freshScanDoc.exists) throw new HttpError('Scan not found', 404);

      const freshScan = scanFromSnapshot(freshScanDoc);
      const brandRef = db.collection('brands').doc(freshScan.brandId);
      const brandDoc = await tx.get(brandRef);
      if (freshScan.userId !== uid) throw new HttpError('Forbidden', 403);
      if (!isScanInProgress(freshScan.status)) {
        throw new HttpError('Scan is not in progress', 409);
      }

      runIds = freshScan.actorRunIds ?? [];
      const brand = brandDoc.exists ? (brandDoc.data() as BrandProfile) : null;

      await clearBrandActiveScanIfMatches(
        brandRef,
        scanId,
        tx,
        brand ?? undefined,
      );

      tx.update(scanDoc.ref, {
        status: 'cancelled',
        completedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.message, err.status);
    }

    throw err;
  }

  // Best-effort abort every Apify run — silently ignore errors for runs that have
  // already finished (Apify simply ignores abort calls on terminal runs)
  const abortResults = await Promise.allSettled(runIds.map((runId) => abortActorRun(runId)));
  abortResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[scan] Failed to abort run ${runIds[i]}:`, result.reason);
    }
  });

  console.log(`[scan] Scan ${scanId} cancelled by user ${uid}; aborted ${runIds.length} run(s)`);

  return NextResponse.json({ data: { scanId, status: 'cancelled' } });
}

/**
 * Derive the app's public base URL for webhook callbacks.
 * Priority: APP_URL env var → x-forwarded-proto + x-forwarded-host headers → host header (http).
 */
function buildAppUrl(request: NextRequest): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }

  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}
