import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import {
  drainBrandDeletion,
  drainBrandHistoryDeletion,
  drainScanDeletion,
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  isScanDeletionActive,
} from '@/lib/async-deletions';
import { normalizeBrandScanSources } from '@/lib/brands';
import { SCAN_SOURCE_ORDER } from '@/lib/scan-sources';
import type { BrandProfile, Scan, ScanSummary, ScanStatus } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

const TERMINAL_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];

function getScanSummarySources(scan: Scan): ScanSummary['sources'] {
  const runSources = new Set(
    Object.values(scan.actorRuns ?? {})
      .map((run) => run.source)
      .filter((source): source is Exclude<NonNullable<ScanSummary['sources']>[number], 'unknown'> => source !== 'unknown'),
  );

  if (runSources.size > 0) {
    return SCAN_SOURCE_ORDER.filter((source) => runSources.has(source));
  }

  if (scan.effectiveSettings?.scanSources) {
    const normalized = normalizeBrandScanSources(scan.effectiveSettings.scanSources);
    return SCAN_SOURCE_ORDER.filter((source) => normalized[source]);
  }

  return [];
}

// GET /api/brands/[brandId]/scans
// Returns all terminal scans for the brand, newest first, using denormalized counts stored
// on each scan document (written by the webhook, updated on ignore/un-ignore/reclassify).
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    void drainBrandDeletion({ brandId, userId: uid }).catch(() => {
      // Non-critical
    });
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(brand)) {
    void drainBrandHistoryDeletion({ brandId, userId: uid }).catch(() => {
      // Non-critical
    });
    return NextResponse.json({ data: [] as ScanSummary[] });
  }

  // Fetch all terminal scans for the brand, newest first
  const scansSnap = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .orderBy('startedAt', 'desc')
    .limit(50)
    .get();

  const allScans = scansSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Scan, 'id'>),
  }));
  const deletingScan = allScans.find((scan) => isScanDeletionActive(scan));
  if (deletingScan) {
    void drainScanDeletion({ brandId, scanId: deletingScan.id, userId: uid }).catch(() => {
      // Non-critical
    });
  }

  const terminalScans = allScans.filter((s) => TERMINAL_STATUSES.includes(s.status));
  const visibleTerminalScans = terminalScans.filter((scan) => !isScanDeletionActive(scan));

  // Use denormalized counts stored on each scan document. The `?? 0` fallback
  // handles scans created before the backfill script ran.
  const summaries: ScanSummary[] = visibleTerminalScans.map((scan) => ({
    id: scan.id,
    status: scan.status,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    highCount: scan.highCount ?? 0,
    mediumCount: scan.mediumCount ?? 0,
    lowCount: scan.lowCount ?? 0,
    nonHitCount: scan.nonHitCount ?? 0,
    ignoredCount: scan.ignoredCount ?? 0,
    addressedCount: scan.addressedCount ?? 0,
    skippedCount: scan.skippedCount ?? 0,
    aiSummary: scan.aiSummary,
    sources: getScanSummarySources(scan),
  }));

  return NextResponse.json({ data: summaries });
}
