import { type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { runWriteBatchInChunks } from '@/lib/firestore-batches';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import type { BrandProfile, FindingSummary } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };
const FINDINGS_PAGE_SIZE = 200;

async function loadMatchingFindingSummaries(
  query: Query,
  matchesFinding: (finding: FindingSummary) => boolean,
): Promise<FindingSummary[]> {
  const findings: FindingSummary[] = [];
  let cursor: QueryDocumentSnapshot | undefined;

  while (true) {
    let pageQuery = query.limit(FINDINGS_PAGE_SIZE);
    if (cursor) {
      pageQuery = pageQuery.startAfter(cursor);
    }

    const snapshot = await pageQuery.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      const finding = {
        id: doc.id,
        ...(doc.data() as Omit<FindingSummary, 'id'>),
      } satisfies FindingSummary;

      if (matchesFinding(finding)) {
        findings.push(finding);
      }
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < FINDINGS_PAGE_SIZE) break;
  }

  return findings;
}

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

  const orderedQuery = query
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
    .orderBy(bookmarkedOnly ? 'bookmarkedAt' : addressedOnly ? 'addressedAt' : 'createdAt', 'desc');

  const matchesFinding = (finding: FindingSummary) => {
    if (bookmarkedOnly) {
      return finding.isBookmarked === true;
    }
    if (addressedOnly) {
      return finding.isAddressed === true && !finding.isFalsePositive;
    }
    if (ignoredOnly) {
      // Only user-manually-ignored real findings (not auto-ignored AI false positives —
      // those have their own non-hits section).
      return finding.isIgnored === true && !finding.isFalsePositive && !finding.isAddressed;
    }
    if (nonHitsOnly) {
      // All AI false positives, regardless of their internal ignored state.
      return finding.isFalsePositive === true;
    }

    // Default: real hits only — exclude AI false-positives, ignored findings, and addressed findings.
    return !finding.isFalsePositive && !finding.isIgnored && !finding.isAddressed;
  };

  const findings = await loadMatchingFindingSummaries(orderedQuery, matchesFinding);

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
