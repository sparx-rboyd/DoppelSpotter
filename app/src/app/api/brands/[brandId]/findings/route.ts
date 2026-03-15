import { Buffer } from 'node:buffer';
import { FieldPath, Timestamp, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
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
import type { BrandProfile, FindingCategory, FindingSource, FindingSummary } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };
const FINDINGS_PAGE_SIZE = 200;
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 100;
const FINDINGS_QUERY_SCAN_BATCH_SIZE = 200;
const MAX_SCANNED_FINDINGS = 5000;

type CrossScanTab = 'bookmarks' | 'addressed' | 'ignored';

type FindingsCursor = {
  sortSeconds: number;
  sortNanoseconds: number;
  findingId: string;
};

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeThemeValue(value?: string) {
  return value?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
}

function parseSearchCategory(value?: string | null): FindingCategory | null {
  const normalized = value?.toLowerCase().replace(/\s+/g, '').trim();
  if (!normalized) return null;
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  if (normalized === 'non-hit' || normalized === 'nonhit' || normalized === 'nonhits') return 'non-hit';
  return null;
}

function parseSearchCategories(values: string[]) {
  const seen = new Set<FindingCategory>();
  const parsedValues: FindingCategory[] = [];

  for (const value of values) {
    const parsedValue = parseSearchCategory(value);
    if (!parsedValue || seen.has(parsedValue)) continue;
    seen.add(parsedValue);
    parsedValues.push(parsedValue);
  }

  return parsedValues;
}

function parseSearchSource(value?: string | null): FindingSource | null {
  if (
    value === 'google'
    || value === 'reddit'
    || value === 'tiktok'
    || value === 'youtube'
    || value === 'facebook'
    || value === 'instagram'
    || value === 'telegram'
    || value === 'apple_app_store'
    || value === 'google_play'
    || value === 'domains'
    || value === 'discord'
    || value === 'github'
    || value === 'x'
    || value === 'unknown'
  ) {
    return value;
  }

  return null;
}

function parseSearchSources(values: string[]) {
  const seen = new Set<FindingSource>();
  const parsedValues: FindingSource[] = [];

  for (const value of values) {
    const parsedValue = parseSearchSource(value);
    if (!parsedValue || seen.has(parsedValue)) continue;
    seen.add(parsedValue);
    parsedValues.push(parsedValue);
  }

  return parsedValues;
}

function parseSearchThemes(values: string[]) {
  const seen = new Set<string>();
  const parsedValues: string[] = [];

  for (const value of values) {
    const normalizedValue = normalizeThemeValue(value);
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    parsedValues.push(normalizedValue);
  }

  return parsedValues;
}

function parseResultLimit(value?: string | null) {
  const parsed = Number.parseInt(value ?? `${DEFAULT_RESULT_LIMIT}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESULT_LIMIT;
  return Math.min(parsed, MAX_RESULT_LIMIT);
}

function encodeCursor(cursor: FindingsCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value?: string | null): FindingsCursor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<FindingsCursor>;
    if (
      typeof parsed.sortSeconds !== 'number'
      || typeof parsed.sortNanoseconds !== 'number'
      || typeof parsed.findingId !== 'string'
      || !parsed.findingId.trim()
    ) {
      return null;
    }

    return {
      sortSeconds: parsed.sortSeconds,
      sortNanoseconds: parsed.sortNanoseconds,
      findingId: parsed.findingId.trim(),
    };
  } catch {
    return null;
  }
}

function buildFindingSearchText(finding: FindingSummary) {
  const xHandleSearchText = finding.xAuthorHandle
    ? `${finding.xAuthorHandle} @${finding.xAuthorHandle}`
    : '';

  return normalizeSearchText(`${finding.title} ${finding.url ?? ''} ${finding.llmAnalysis} ${xHandleSearchText}`);
}

function matchesCrossScanTabFilters(
  finding: FindingSummary,
  params: {
    tab: CrossScanTab;
    normalizedQuery: string;
    categorySet: Set<FindingCategory>;
    sourceSet: Set<FindingSource>;
    normalizedThemeSet: Set<string>;
  },
) {
  if (params.tab === 'bookmarks' && finding.isBookmarked !== true) {
    return false;
  }
  if (params.tab === 'addressed' && !(finding.isAddressed === true && !finding.isFalsePositive)) {
    return false;
  }
  if (params.tab === 'ignored' && !(finding.isIgnored === true && !finding.isFalsePositive && !finding.isAddressed)) {
    return false;
  }

  if (params.normalizedQuery && !buildFindingSearchText(finding).includes(params.normalizedQuery)) {
    return false;
  }

  if (params.categorySet.size > 0) {
    const matchesCategory = finding.isFalsePositive === true
      ? params.categorySet.has('non-hit')
      : params.categorySet.has(finding.severity);
    if (!matchesCategory) return false;
  }

  if (params.sourceSet.size > 0 && !params.sourceSet.has(finding.source)) {
    return false;
  }

  if (
    params.normalizedThemeSet.size > 0
    && !params.normalizedThemeSet.has(normalizeThemeValue(finding.theme))
  ) {
    return false;
  }

  return true;
}

async function loadMatchingFindingSummaries(
  query: Query,
  matchesFinding: (finding: FindingSummary) => boolean,
  options?: { matchLimit?: number },
): Promise<{ findings: FindingSummary[]; truncated: boolean }> {
  const findings: FindingSummary[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  const resultLimit = options?.matchLimit;

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
        if (resultLimit !== undefined && findings.length >= resultLimit + 1) {
          break;
        }
      }
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (resultLimit !== undefined && findings.length >= resultLimit + 1) {
      break;
    }
    if (snapshot.size < FINDINGS_PAGE_SIZE) break;
  }

  if (resultLimit === undefined) {
    return { findings, truncated: false };
  }

  const truncated = findings.length > resultLimit;
  return {
    findings: truncated ? findings.slice(0, resultLimit) : findings,
    truncated,
  };
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
  const rawQuery = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const normalizedQuery = normalizeSearchText(rawQuery);
  const categories = parseSearchCategories(request.nextUrl.searchParams.getAll('category'));
  const sources = parseSearchSources(request.nextUrl.searchParams.getAll('source'));
  const normalizedThemes = parseSearchThemes(request.nextUrl.searchParams.getAll('theme'));
  const categorySet = new Set(categories);
  const sourceSet = new Set(sources);
  const normalizedThemeSet = new Set(normalizedThemes);
  const resultLimit = parseResultLimit(request.nextUrl.searchParams.get('limit'));
  const parsedCursor = decodeCursor(request.nextUrl.searchParams.get('cursor'));
  const includeCount = request.nextUrl.searchParams.get('includeCount') === 'true';
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';
  const ignoredOnly = request.nextUrl.searchParams.get('ignoredOnly') === 'true';
  const addressedOnly = request.nextUrl.searchParams.get('addressedOnly') === 'true';
  const bookmarkedOnly = request.nextUrl.searchParams.get('bookmarkedOnly') === 'true';
  const scanId = request.nextUrl.searchParams.get('scanId');
  const crossScanTab: CrossScanTab | null = bookmarkedOnly
    ? 'bookmarks'
    : addressedOnly
      ? 'addressed'
      : ignoredOnly
        ? 'ignored'
        : null;

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

  if (!scanId && crossScanTab) {
    let query: Query = db
      .collection('findings')
      .where('brandId', '==', brandId)
      .where('userId', '==', uid);

    if (crossScanTab === 'bookmarks') {
      query = query.where('isBookmarked', '==', true);
    } else if (crossScanTab === 'addressed') {
      query = query.where('isAddressed', '==', true);
    } else {
      query = query.where('isIgnored', '==', true);
    }

    const primarySortField = crossScanTab === 'bookmarks'
      ? 'bookmarkedAt'
      : crossScanTab === 'addressed'
        ? 'addressedAt'
        : 'createdAt';

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
        'registrationDate',
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
      .orderBy(primarySortField, 'desc')
      .orderBy(FieldPath.documentId(), 'desc');

    const collectedMatches: FindingSummary[] = [];
    const collectedMatchCursors: FindingsCursor[] = [];
    let lastScannedCursor = parsedCursor;
    let scannedFindings = 0;
    let exhausted = false;
    let matchedCount = 0;

    while ((includeCount || collectedMatches.length < resultLimit + 1) && scannedFindings < MAX_SCANNED_FINDINGS) {
      let pageQuery = orderedQuery.limit(FINDINGS_QUERY_SCAN_BATCH_SIZE);
      if (lastScannedCursor) {
        pageQuery = pageQuery.startAfter(
          new Timestamp(lastScannedCursor.sortSeconds, lastScannedCursor.sortNanoseconds),
          lastScannedCursor.findingId,
        );
      }

      const snapshot = await pageQuery.get();
      if (snapshot.empty) {
        exhausted = true;
        break;
      }

      for (const doc of snapshot.docs) {
        const finding = {
          id: doc.id,
          ...(doc.data() as Omit<FindingSummary, 'id'>),
        } satisfies FindingSummary;

        const sortValue = crossScanTab === 'bookmarks'
          ? finding.bookmarkedAt ?? finding.createdAt
          : crossScanTab === 'addressed'
            ? finding.addressedAt ?? finding.createdAt
            : finding.createdAt;

        lastScannedCursor = {
          sortSeconds: sortValue.seconds,
          sortNanoseconds: sortValue.nanoseconds,
          findingId: finding.id,
        };
        scannedFindings++;

        if (
          !deletingScanIds.has(finding.scanId)
          && matchesCrossScanTabFilters(finding, {
            tab: crossScanTab,
            normalizedQuery,
            categorySet,
            sourceSet,
            normalizedThemeSet,
          })
        ) {
          matchedCount++;
          if (collectedMatches.length < resultLimit + 1) {
            collectedMatches.push(finding);
            collectedMatchCursors.push(lastScannedCursor);
          }
          if (!includeCount && collectedMatches.length >= resultLimit + 1) {
            break;
          }
        }

        if (scannedFindings >= MAX_SCANNED_FINDINGS) {
          break;
        }
      }

      if (snapshot.size < FINDINGS_QUERY_SCAN_BATCH_SIZE) {
        exhausted = true;
        break;
      }
    }

    const hasMore = collectedMatches.length > resultLimit;
    const visibleMatches = hasMore ? collectedMatches.slice(0, resultLimit) : collectedMatches;
    const visibleMatchCursors = hasMore ? collectedMatchCursors.slice(0, resultLimit) : collectedMatchCursors;
    const nextCursor = hasMore && visibleMatchCursors.length > 0
      ? encodeCursor(visibleMatchCursors[visibleMatchCursors.length - 1])
      : null;
    const truncated = !hasMore && !exhausted && scannedFindings >= MAX_SCANNED_FINDINGS;
    const totalCount = includeCount ? matchedCount : undefined;

    return NextResponse.json({
      data: visibleMatches,
      nextCursor,
      hasMore,
      truncated,
      ...(totalCount !== undefined ? { totalCount } : {}),
    });
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
      'registrationDate',
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

  const { findings } = await loadMatchingFindingSummaries(orderedQuery, matchesFinding);

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
