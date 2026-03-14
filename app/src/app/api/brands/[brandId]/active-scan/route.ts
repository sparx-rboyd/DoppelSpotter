import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
} from '@/lib/async-deletions';
import { sendCompletedScanSummaryEmailIfNeeded } from '@/lib/scan-summary-emails';
import type { BrandProfile } from '@/lib/types';
import {
  clearBrandActiveScanIfMatches,
  isScanInProgress,
  recoverStuckPendingScan,
  recoverStuckSummarisingScan,
  scanFromSnapshot,
} from '@/lib/scans';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/active-scan
// Returns the current in-progress scan for this brand, if any.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const brandRef = db.collection('brands').doc(brandId);
  const brandDoc = await brandRef.get();

  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(brand)) {
    return NextResponse.json({ data: null });
  }

  if (!brand.activeScanId) {
    return NextResponse.json({ data: null });
  }

  const scanDoc = await db.collection('scans').doc(brand.activeScanId).get();
  if (!scanDoc.exists) {
    await clearBrandActiveScanIfMatches(brandRef, brand.activeScanId);
    return NextResponse.json({ data: null });
  }

  let scan = scanFromSnapshot(scanDoc);
  if (scan.status === 'pending') {
    const recovered = await recoverStuckPendingScan(scanDoc.ref);
    if (recovered) {
      const refreshedScanDoc = await scanDoc.ref.get();
      if (!refreshedScanDoc.exists) {
        await clearBrandActiveScanIfMatches(brandRef, brand.activeScanId);
        return NextResponse.json({ data: null });
      }
      scan = scanFromSnapshot(refreshedScanDoc);
    }
  }
  if (scan.status === 'summarising') {
    const recovered = await recoverStuckSummarisingScan(scanDoc.ref);
    if (recovered) {
      await sendCompletedScanSummaryEmailIfNeeded(scanDoc.ref);
      const refreshedScanDoc = await scanDoc.ref.get();
      if (!refreshedScanDoc.exists) {
        await clearBrandActiveScanIfMatches(brandRef, brand.activeScanId);
        return NextResponse.json({ data: null });
      }
      scan = scanFromSnapshot(refreshedScanDoc);
    }
  }

  if (
    scan.brandId !== brandId ||
    scan.userId !== uid ||
    !isScanInProgress(scan.status)
  ) {
    await clearBrandActiveScanIfMatches(brandRef, brand.activeScanId);
    return NextResponse.json({ data: null });
  }

  return NextResponse.json({ data: scan });
}
