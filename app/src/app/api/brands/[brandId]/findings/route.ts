import { type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import {
  drainBrandHistoryDeletion,
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  loadDeletingScanIdsForBrand,
  markBrandHistoryDeletionQueued,
} from '@/lib/async-deletions';
import { scheduleDeletionTaskOrRunInline } from '@/lib/deletion-tasks';
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

  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(brand)) {
    return NextResponse.json({ data: [] });
  }

  const deletingScanIds = new Set(await loadDeletingScanIdsForBrand({ brandId, userId: uid }));

  if (scanId && deletingScanIds.has(scanId)) {
    return NextResponse.json({ data: [] });
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
      'xAuthorId',
      'xAuthorHandle',
      'xAuthorUrl',
      'xMatchBasis',
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
    if (deletingScanIds.has(finding.scanId)) {
      return false;
    }
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
  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) return errorResponse('Brand is already being deleted', 409);

  if (isBrandHistoryDeletionActive(brand)) {
    await scheduleDeletionTaskOrRunInline({
      payload: {
        kind: 'brand-history',
        brandId,
        userId: uid,
      },
      requestHeaders: request.headers,
      logPrefix: `[brand-history-delete] Brand ${brandId}`,
      runInline: () => drainBrandHistoryDeletion({ brandId, userId: uid }),
    });
    return new NextResponse(null, { status: 202 });
  }

  const scansSnap = await db.collection('scans').where('brandId', '==', brandId).where('userId', '==', uid).get();

  const activeScan = scansSnap.docs
    .map(scanFromSnapshot)
    .find((scan) => isScanInProgress(scan.status));

  if (activeScan) {
    return errorResponse('Cannot clear history while a scan is still in progress', 409);
  }

  await markBrandHistoryDeletionQueued(brandId);
  await scheduleDeletionTaskOrRunInline({
    payload: {
      kind: 'brand-history',
      brandId,
      userId: uid,
    },
    requestHeaders: request.headers,
    logPrefix: `[brand-history-delete] Brand ${brandId}`,
    runInline: () => drainBrandHistoryDeletion({ brandId, userId: uid }),
  });

  return new NextResponse(null, { status: 202 });
}
