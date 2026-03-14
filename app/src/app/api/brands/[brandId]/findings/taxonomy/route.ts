import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  loadDeletingScanIdsForBrand,
} from '@/lib/async-deletions';
import type { BrandProfile } from '@/lib/types';
import { loadBrandFindingTaxonomy } from '@/lib/findings-taxonomy';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/findings/taxonomy
// Returns distinct brand-scoped theme labels for filter dropdowns.
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const excludeScanId = request.nextUrl.searchParams.get('excludeScanId')?.trim() || undefined;

  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(brand)) {
    return NextResponse.json({ data: { themes: [] } });
  }

  const deletingScanIds = await loadDeletingScanIdsForBrand({ brandId, userId: uid });

  const taxonomy = await loadBrandFindingTaxonomy({
    brandId,
    userId: uid,
    excludeScanId,
    excludeScanIds: deletingScanIds,
  });

  return NextResponse.json({ data: taxonomy });
}
