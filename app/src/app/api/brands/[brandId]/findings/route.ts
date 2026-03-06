import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, FindingSummary } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/findings
// Query params:
//   nonHitsOnly    (optional) — when "true", returns only AI-classified false-positives
//   ignoredOnly    (optional) — when "true", returns only user-ignored findings (across all scans if no scanId)
//   bookmarkedOnly (optional) — when "true", returns only bookmarked findings (across all scans if no scanId)
//   scanId         (optional) — when provided, filters findings to a specific scan
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';
  const ignoredOnly = request.nextUrl.searchParams.get('ignoredOnly') === 'true';
  const bookmarkedOnly = request.nextUrl.searchParams.get('bookmarkedOnly') === 'true';
  const scanId = request.nextUrl.searchParams.get('scanId');

  // Authorization is enforced by the userId filter in every Firestore query below —
  // a user can only retrieve findings that belong to them. We still verify brand
  // existence for the cross-scan ignoredOnly path to return a proper 404, but skip
  // it for per-scan queries where an empty result is a sufficient response.
  if ((ignoredOnly || bookmarkedOnly) && !scanId) {
    const brandDoc = await db.collection('brands').doc(brandId).get();
    if (!brandDoc.exists) return errorResponse('Brand not found', 404);
    if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);
  }

  let query = db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid);

  if (scanId) {
    query = query.where('scanId', '==', scanId);
  }

  // For cross-scan ignored/bookmarked queries, filter at the Firestore level so we only
  // fetch the small number of matching documents rather than all findings for the brand.
  // Requires composite indexes:
  // - brandId ASC, userId ASC, isIgnored ASC, createdAt DESC
  // - brandId ASC, userId ASC, isBookmarked ASC, bookmarkedAt DESC
  if (ignoredOnly && !scanId) {
    query = query.where('isIgnored', '==', true);
  }
  if (bookmarkedOnly) {
    query = query.where('isBookmarked', '==', true);
  }

  const snapshot = await query
    .select(
      'scanId',
      'brandId',
      'source',
      'severity',
      'title',
      'llmAnalysis',
      'url',
      'isFalsePositive',
      'isIgnored',
      'isBookmarked',
      'bookmarkNote',
      'bookmarkedAt',
      'createdAt',
    )
    .orderBy(bookmarkedOnly ? 'bookmarkedAt' : 'createdAt', 'desc')
    .limit(200)
    .get();

  const all: FindingSummary[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<FindingSummary, 'id'>),
  }));

  let findings: FindingSummary[];
  if (bookmarkedOnly) {
    findings = all.filter((f) => f.isBookmarked === true);
  } else if (ignoredOnly) {
    // Only user-manually-ignored real findings (not auto-ignored AI false positives —
    // those have their own non-hits section).
    findings = all.filter((f) => f.isIgnored === true && !f.isFalsePositive);
  } else if (nonHitsOnly) {
    // All AI false positives, regardless of their ignored state (auto-ignored or
    // explicitly un-ignored by the user).
    findings = all.filter((f) => f.isFalsePositive === true);
  } else {
    // Default: real hits only — exclude AI false-positives and user-ignored findings
    findings = all.filter((f) => !f.isFalsePositive && !f.isIgnored);
  }

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
