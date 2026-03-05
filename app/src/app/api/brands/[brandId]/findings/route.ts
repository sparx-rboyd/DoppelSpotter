import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, Finding } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/findings
// Query params:
//   nonHitsOnly  (optional) — when "true", returns only LLM false-positives; otherwise returns only real findings
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  const snapshot = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();

  const all: Finding[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Finding, 'id'>),
  }));

  const findings = nonHitsOnly
    ? all.filter((f) => f.isFalsePositive === true)
    : all.filter((f) => !f.isFalsePositive);

  return NextResponse.json({ data: findings });
}

// DELETE /api/brands/[brandId]/findings
// Permanently deletes all findings AND scan records for this brand.
export async function DELETE(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  // Fetch all findings and scans for this brand
  const [findingsSnap, scansSnap] = await Promise.all([
    db.collection('findings').where('brandId', '==', brandId).where('userId', '==', uid).get(),
    db.collection('scans').where('brandId', '==', brandId).where('userId', '==', uid).get(),
  ]);

  const allDocs = [...findingsSnap.docs, ...scansSnap.docs];

  // Firestore batch limit is 500 — chunk if needed
  const BATCH_LIMIT = 500;
  for (let i = 0; i < allDocs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    allDocs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  return new NextResponse(null, { status: 204 });
}
