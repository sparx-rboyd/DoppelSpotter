import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, Finding } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/findings
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;

  // Verify brand ownership
  const brandDoc = await adminDb.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  const snapshot = await adminDb
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();

  const findings: Finding[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Finding, 'id'>),
  }));

  return NextResponse.json({ data: findings });
}
