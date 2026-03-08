import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { drainScanDeletion, isBrandDeletionActive, isBrandHistoryDeletionActive, isScanDeletionActive, markScanDeletionQueued } from '@/lib/async-deletions';
import type { BrandProfile, Scan } from '@/lib/types';

type Params = { params: Promise<{ brandId: string; scanId: string }> };

// DELETE /api/brands/[brandId]/scans/[scanId]
// Permanently deletes a single scan and all its findings.
export async function DELETE(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId, scanId } = await params;

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  // Fetch and verify the scan
  const scanDoc = await db.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) return errorResponse('Scan not found', 404);

  const scan = scanDoc.data() as Scan;
  if (scan.userId !== uid) return errorResponse('Forbidden', 403);
  if (scan.brandId !== brandId) return errorResponse('Scan does not belong to this brand', 400);
  if (isBrandDeletionActive(brandDoc.data() as BrandProfile) || isBrandHistoryDeletionActive(brandDoc.data() as BrandProfile)) {
    return errorResponse('Cannot delete an individual scan while brand deletion is already in progress', 409);
  }

  if (scan.status === 'pending' || scan.status === 'running') {
    return errorResponse('Cannot delete a scan that is still in progress', 409);
  }

  if (!isScanDeletionActive(scan)) {
    await markScanDeletionQueued(scanId);
  }

  void drainScanDeletion({ brandId, scanId, userId: uid }).catch((error) => {
    console.error(`[scan-delete] Failed to process deletion for scan ${scanId}:`, error);
  });

  return new NextResponse(null, { status: 202 });
}
