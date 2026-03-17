import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
} from '@/lib/async-deletions';
import {
  triggerDashboardExecutiveSummaryRefresh,
} from '@/lib/dashboard-executive-summary';
import type { BrandProfile } from '@/lib/types';

function ensureDebugMode(request: NextRequest) {
  if (request.nextUrl.searchParams.get('debug') === 'true') return null;
  return errorResponse('Dashboard executive summary is only available when debug=true', 404);
}

export async function POST(request: NextRequest) {
  const debugError = ensureDebugMode(request);
  if (debugError) return debugError;

  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const brandId = request.nextUrl.searchParams.get('brandId');
  if (!brandId) {
    return errorResponse('brandId is required');
  }

  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) return errorResponse('Brand not found', 404);
  if (isBrandHistoryDeletionActive(brand)) {
    return errorResponse('Cannot generate an executive summary while brand history deletion is in progress', 409);
  }

  const requestedForScanId = brand.dashboardExecutiveSummary?.requestedForScanId
    ?? brand.dashboardExecutiveSummary?.generatedFromScanId;

  await triggerDashboardExecutiveSummaryRefresh({
    brandId,
    userId: uid,
    requestedForScanId,
    requestHeaders: request.headers,
    logPrefix: `[dashboard-executive-summary] Brand ${brandId}`,
    force: true,
  });

  const refreshedBrandDoc = await db.collection('brands').doc(brandId).get();
  const refreshedBrand = refreshedBrandDoc.exists ? refreshedBrandDoc.data() as BrandProfile : null;
  return NextResponse.json({
    data: refreshedBrand?.dashboardExecutiveSummary ?? null,
  }, { status: 202 });
}
