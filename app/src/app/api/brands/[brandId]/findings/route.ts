import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type { BrandProfile, FindingSummary } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]/findings
// Query params:
//   nonHitsOnly    (optional) — when "true", returns only AI-classified false-positives
//   ignoredOnly    (optional) — when "true", returns only user-ignored findings (across all scans if no scanId)
//   addressedOnly  (optional) — when "true", returns only user-addressed findings (across all scans if no scanId)
//   bookmarkedOnly (optional) — when "true", returns only bookmarked findings (across all scans if no scanId)
//   scanId         (optional) — when provided, filters findings to a specific scan
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';
  const ignoredOnly = request.nextUrl.searchParams.get('ignoredOnly') === 'true';
  const addressedOnly = request.nextUrl.searchParams.get('addressedOnly') === 'true';
  const bookmarkedOnly = request.nextUrl.searchParams.get('bookmarkedOnly') === 'true';
  const scanId = request.nextUrl.searchParams.get('scanId');

  // Authorization is enforced by the userId filter in every Firestore query below —
  // a user can only retrieve findings that belong to them. We still verify brand
  // existence for the cross-scan ignoredOnly path to return a proper 404, but skip
  // it for per-scan queries where an empty result is a sufficient response.
  if ((ignoredOnly || addressedOnly || bookmarkedOnly) && !scanId) {
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
  // - brandId ASC, userId ASC, isAddressed ASC, addressedAt DESC
  // - brandId ASC, userId ASC, isBookmarked ASC, bookmarkedAt DESC
  if (ignoredOnly && !scanId) {
    query = query.where('isIgnored', '==', true);
  }
  if (addressedOnly) {
    query = query.where('isAddressed', '==', true);
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
      'theme',
      'llmAnalysis',
      'url',
      'isFalsePositive',
      'isIgnored',
      'isAddressed',
      'isBookmarked',
      'addressedAt',
      'bookmarkNote',
      'bookmarkedAt',
      'createdAt',
    )
    .orderBy(bookmarkedOnly ? 'bookmarkedAt' : addressedOnly ? 'addressedAt' : 'createdAt', 'desc')
    .limit(200)
    .get();

  const all: FindingSummary[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<FindingSummary, 'id'>),
  }));

  let findings: FindingSummary[];
  if (bookmarkedOnly) {
    findings = all.filter((f) => f.isBookmarked === true);
  } else if (addressedOnly) {
    findings = all.filter((f) => f.isAddressed === true && !f.isFalsePositive);
  } else if (ignoredOnly) {
    // Only user-manually-ignored real findings (not auto-ignored AI false positives —
    // those have their own non-hits section).
    findings = all.filter((f) => f.isIgnored === true && !f.isFalsePositive && !f.isAddressed);
  } else if (nonHitsOnly) {
    // All AI false positives, regardless of their internal ignored state.
    findings = all.filter((f) => f.isFalsePositive === true);
  } else {
    // Default: real hits only — exclude AI false-positives, ignored findings, and addressed findings.
    findings = all.filter((f) => !f.isFalsePositive && !f.isIgnored && !f.isAddressed);
  }

  return NextResponse.json({ data: findings });
}

// DELETE /api/brands/[brandId]/findings
// Permanently deletes all findings AND scan records for this brand.
export async function DELETE(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
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

  const activeScan = scansSnap.docs
    .map(scanFromSnapshot)
    .find((scan) => isScanInProgress(scan.status));

  if (activeScan) {
    return errorResponse('Cannot clear history while a scan is still in progress', 409);
  }

  const allDocs = [...findingsSnap.docs, ...scansSnap.docs];

  await runWriteBatchInChunks(allDocs, (batch, doc) => batch.delete(doc.ref));

  return new NextResponse(null, { status: 204 });
}
