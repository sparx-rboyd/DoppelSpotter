import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import type { BrandProfile, Scan } from '@/lib/types';
import { abortActorRun } from '@/lib/apify/client';
import {
  clearBrandActiveScanIfMatches,
  isScanInProgress,
  recoverStuckPendingScan,
  recoverStuckSummarisingScan,
  scanFromSnapshot,
} from '@/lib/scans';
import {
  ActiveScanConflictError,
  ScanStartError,
  startScanForBrand,
} from '@/lib/scan-runner';

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

  try {
    const result = await startScanForBrand({
      brandId,
      actorIds,
      ownerUserId: uid,
      requestHeaders: request.headers,
    });

    if (result.outcome === 'skipped') {
      return errorResponse('Failed to prepare scan', 500);
    }

    return NextResponse.json(
      { data: { scanId: result.scanId, status: result.status, actorCount: result.actorCount } },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ScanStartError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof ActiveScanConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'ACTIVE_SCAN_EXISTS',
          data: { activeScan: error.scan },
        },
        { status: 409 },
      );
    }

    throw error;
  }
}

// GET /api/scan?scanId=xxx — poll scan status
export async function GET(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const scanId = request.nextUrl.searchParams.get('scanId');
  if (!scanId) return errorResponse('scanId query param is required');

  const scanDoc = await db.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) return errorResponse('Scan not found', 404);

  let scan = scanDoc.data() as Omit<Scan, 'id'>;
  if (scan.userId !== uid) return errorResponse('Forbidden', 403);

  if (scan.status === 'pending') {
    const recovered = await recoverStuckPendingScan(scanDoc.ref);
    if (recovered) {
      const refreshedScanDoc = await scanDoc.ref.get();
      if (refreshedScanDoc.exists) {
        scan = refreshedScanDoc.data() as Omit<Scan, 'id'>;
      }
    }
  }

  if (scan.status === 'summarising') {
    const recovered = await recoverStuckSummarisingScan(scanDoc.ref);
    if (recovered) {
      const refreshedScanDoc = await scanDoc.ref.get();
      if (refreshedScanDoc.exists) {
        scan = refreshedScanDoc.data() as Omit<Scan, 'id'>;
      }
    }
  }

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

  if (!isScanInProgress(scan.status)) {
    return errorResponse('Scan is not in progress', 409);
  }

  let runIds: string[] = [];

  // Mark the scan cancelled first so any in-flight webhook callbacks are ignored
  try {
    await db.runTransaction(async (tx) => {
      const freshScanDoc = await tx.get(scanDoc.ref);
      if (!freshScanDoc.exists) throw new ScanStartError('Scan not found', 404);

      const freshScan = scanFromSnapshot(freshScanDoc);
      const brandRef = db.collection('brands').doc(freshScan.brandId);
      const brandDoc = await tx.get(brandRef);
      if (freshScan.userId !== uid) throw new ScanStartError('Forbidden', 403);
      if (!isScanInProgress(freshScan.status)) {
        throw new ScanStartError('Scan is not in progress', 409);
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
  } catch (error) {
    if (error instanceof ScanStartError) {
      return errorResponse(error.message, error.status);
    }

    throw error;
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

