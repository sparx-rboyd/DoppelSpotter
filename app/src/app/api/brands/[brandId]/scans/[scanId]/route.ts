import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { drainScanDeletion, isBrandDeletionActive, isBrandHistoryDeletionActive, isScanDeletionActive, markScanDeletionQueued } from '@/lib/async-deletions';
import { scheduleDeletionTaskOrRunInline } from '@/lib/deletion-tasks';
import { scanFromSnapshot } from '@/lib/scans';
import { buildScanAiSummary, saveScanAiSummary } from '@/lib/scan-summary';
import type { BrandProfile } from '@/lib/types';

type Params = { params: Promise<{ brandId: string; scanId: string }> };

async function getOwnedBrandAndScan(request: NextRequest, params: Params['params']) {
  const { uid, error } = await requireAuth(request);
  if (error) {
    return { error };
  }

  const { brandId, scanId } = await params;
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) {
    return { error: errorResponse('Brand not found', 404) };
  }

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) {
    return { error: errorResponse('Forbidden', 403) };
  }

  const scanDoc = await db.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) {
    return { error: errorResponse('Scan not found', 404) };
  }

  const scan = scanFromSnapshot(scanDoc);
  if (scan.userId !== uid) {
    return { error: errorResponse('Forbidden', 403) };
  }
  if (scan.brandId !== brandId) {
    return { error: errorResponse('Scan does not belong to this brand', 400) };
  }

  return {
    uid,
    brandId,
    scanId,
    brand,
    brandDoc,
    scan,
    scanDoc,
  };
}

function ensureDebugMode(request: NextRequest) {
  if (request.nextUrl.searchParams.get('debug') === 'true') return null;
  return errorResponse('Debug summary regeneration is only available when debug=true', 404);
}

// GET /api/brands/[brandId]/scans/[scanId]
// Returns scan-level debug fields used by the brand page when ?debug=true.
export async function GET(request: NextRequest, { params }: Params) {
  const owned = await getOwnedBrandAndScan(request, params);
  if ('error' in owned) return owned.error;
  const { scan, scanDoc } = owned;

  return NextResponse.json({
    data: {
      id: scanDoc.id,
      aiSummary: scan.aiSummary,
      scanSummaryRawLlmResponse: scan.scanSummaryRawLlmResponse,
    },
  });
}

// POST /api/brands/[brandId]/scans/[scanId]?debug=true
// Regenerates a scan summary preview without persisting it.
export async function POST(request: NextRequest, { params }: Params) {
  const debugError = ensureDebugMode(request);
  if (debugError) return debugError;

  const owned = await getOwnedBrandAndScan(request, params);
  if ('error' in owned) return owned.error;

  const summaryResult = await buildScanAiSummary(owned.scan);
  return NextResponse.json({
    data: {
      id: owned.scanDoc.id,
      regeneratedSummary: summaryResult.summary,
      regeneratedScanSummaryRawLlmResponse: summaryResult.rawLlmResponse,
    },
  });
}

// PATCH /api/brands/[brandId]/scans/[scanId]?debug=true
// Persists a regenerated debug summary preview onto the scan.
export async function PATCH(request: NextRequest, { params }: Params) {
  const debugError = ensureDebugMode(request);
  if (debugError) return debugError;

  const owned = await getOwnedBrandAndScan(request, params);
  if ('error' in owned) return owned.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const summary = typeof (body as { summary?: unknown })?.summary === 'string'
    ? (body as { summary: string }).summary.trim()
    : '';
  const rawLlmResponse = typeof (body as { rawLlmResponse?: unknown })?.rawLlmResponse === 'string'
    ? (body as { rawLlmResponse: string }).rawLlmResponse
    : undefined;

  if (!summary) {
    return errorResponse('summary is required');
  }

  await saveScanAiSummary(owned.scanDoc.id, {
    summary,
    rawLlmResponse,
  });

  return NextResponse.json({
    data: {
      id: owned.scanDoc.id,
      aiSummary: summary,
      scanSummaryRawLlmResponse: rawLlmResponse,
    },
  });
}

// DELETE /api/brands/[brandId]/scans/[scanId]
// Permanently deletes a single scan and all its findings.
export async function DELETE(request: NextRequest, { params }: Params) {
  const owned = await getOwnedBrandAndScan(request, params);
  if ('error' in owned) return owned.error;

  const { uid, brandId, scanId, brand, scan } = owned;
  if (isBrandDeletionActive(brand) || isBrandHistoryDeletionActive(brand)) {
    return errorResponse('Cannot delete an individual scan while brand deletion is already in progress', 409);
  }

  if (scan.status === 'pending' || scan.status === 'running') {
    return errorResponse('Cannot delete a scan that is still in progress', 409);
  }

  if (!isScanDeletionActive(scan)) {
    await markScanDeletionQueued(scanId);
  }

  await scheduleDeletionTaskOrRunInline({
    payload: {
      kind: 'scan',
      brandId,
      scanId,
      userId: uid,
    },
    requestHeaders: request.headers,
    logPrefix: `[scan-delete] Scan ${scanId}`,
    runInline: () => drainScanDeletion({ brandId, scanId, userId: uid }),
  });

  return new NextResponse(null, { status: 202 });
}
