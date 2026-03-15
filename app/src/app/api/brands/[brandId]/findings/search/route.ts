import { Buffer } from 'node:buffer';
import { FieldPath, Timestamp, type Query } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  loadDeletingScanIdsForBrand,
} from '@/lib/async-deletions';
import type { BrandProfile, FindingCategory, FindingSource, FindingSummary, ScanStatus } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

type FindingSearchDisplayBucket = 'hit' | 'non-hit' | 'ignored' | 'addressed';

type FindingSearchResult = FindingSummary & {
  displayBucket: FindingSearchDisplayBucket;
  scanStartedAt?: FindingSummary['createdAt'];
  scanStatus?: ScanStatus;
};

type SearchCursor = {
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  findingId: string;
};

type FindingSearchScope = 'scans' | 'bookmarks' | 'ignored' | 'addressed';

const MIN_SEARCH_QUERY_LENGTH = 2;
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 100;
const SEARCH_SCAN_BATCH_SIZE = 200;
const MAX_SCANNED_FINDINGS = 5000;

function parseFindingIds(values: string[]) {
  const seen = new Set<string>();
  const parsedValues: string[] = [];

  for (const value of values) {
    const trimmedValue = value.trim();
    if (!trimmedValue || seen.has(trimmedValue)) continue;
    seen.add(trimmedValue);
    parsedValues.push(trimmedValue);
  }

  return parsedValues;
}

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

function parseSearchScope(value?: string | null): FindingSearchScope {
  if (value === 'bookmarks' || value === 'ignored' || value === 'addressed') {
    return value;
  }

  return 'scans';
}

function parseIncludeCount(value?: string | null) {
  return value === '1' || value === 'true';
}

function encodeCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value?: string | null): SearchCursor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SearchCursor>;
    if (
      typeof parsed.createdAtSeconds !== 'number'
      || typeof parsed.createdAtNanoseconds !== 'number'
      || typeof parsed.findingId !== 'string'
      || !parsed.findingId.trim()
    ) {
      return null;
    }

    return {
      createdAtSeconds: parsed.createdAtSeconds,
      createdAtNanoseconds: parsed.createdAtNanoseconds,
      findingId: parsed.findingId.trim(),
    };
  } catch {
    return null;
  }
}

function getFindingDisplayBucket(finding: Pick<FindingSummary, 'isFalsePositive' | 'isIgnored' | 'isAddressed'>): FindingSearchDisplayBucket {
  if (finding.isFalsePositive === true) return 'non-hit';
  if (finding.isAddressed === true) return 'addressed';
  if (finding.isIgnored === true) return 'ignored';
  return 'hit';
}

function matchesSearchScope(
  finding: Pick<FindingSummary, 'isFalsePositive' | 'isIgnored' | 'isAddressed' | 'isBookmarked'>,
  scope: FindingSearchScope,
) {
  if (scope === 'bookmarks') {
    return finding.isBookmarked === true;
  }

  const displayBucket = getFindingDisplayBucket(finding);
  if (scope === 'scans') {
    return displayBucket === 'hit' || displayBucket === 'non-hit';
  }
  if (scope === 'ignored') {
    return displayBucket === 'ignored';
  }
  return displayBucket === 'addressed';
}

function getFindingSearchPriority(finding: FindingSummary) {
  if (finding.isFalsePositive === true) return 3;
  if (finding.severity === 'high') return 0;
  if (finding.severity === 'medium') return 1;
  return 2;
}

function buildFindingSearchText(finding: FindingSummary) {
  const xHandleSearchText = finding.xAuthorHandle
    ? `${finding.xAuthorHandle} @${finding.xAuthorHandle}`
    : '';

  return normalizeSearchText(`${finding.title} ${finding.url ?? ''} ${finding.llmAnalysis} ${xHandleSearchText}`);
}

function matchesSearchFilters(
  finding: FindingSummary,
  params: {
    normalizedQuery: string;
    categorySet: Set<FindingCategory>;
    sourceSet: Set<FindingSource>;
    normalizedThemeSet: Set<string>;
    scope: FindingSearchScope;
  },
) {
  if (!matchesSearchScope(finding, params.scope)) {
    return false;
  }

  const matchesText = buildFindingSearchText(finding).includes(params.normalizedQuery);
  if (!matchesText) return false;

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

async function loadScanContextById(scanIds: string[]) {
  if (scanIds.length === 0) {
    return new Map<string, { startedAt?: FindingSummary['createdAt']; status?: ScanStatus }>();
  }

  const refs = scanIds.map((scanId) => db.collection('scans').doc(scanId));
  const snapshots = await db.getAll(...refs);

  return new Map(
    snapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => {
        const data = snapshot.data() as { startedAt?: FindingSummary['createdAt']; status?: ScanStatus };
        return [
          snapshot.id,
          {
            startedAt: data.startedAt,
            status: data.status,
          },
        ];
      }),
  );
}

export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const findingIds = parseFindingIds(request.nextUrl.searchParams.getAll('findingId'));
  const rawQuery = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const normalizedQuery = normalizeSearchText(rawQuery);
  const categories = parseSearchCategories(request.nextUrl.searchParams.getAll('category'));
  const sources = parseSearchSources(request.nextUrl.searchParams.getAll('source'));
  const normalizedThemes = parseSearchThemes(request.nextUrl.searchParams.getAll('theme'));
  const categorySet = new Set(categories);
  const sourceSet = new Set(sources);
  const normalizedThemeSet = new Set(normalizedThemes);
  const hasActiveFilters = categories.length > 0 || sources.length > 0 || normalizedThemes.length > 0;
  const isFilterOnlyRequest = normalizedQuery.length === 0 && hasActiveFilters;
  const scanId = request.nextUrl.searchParams.get('scanId')?.trim() ?? '';
  const scope = parseSearchScope(request.nextUrl.searchParams.get('tab'));
  const resultLimit = parseResultLimit(request.nextUrl.searchParams.get('limit'));
  const includeCount = parseIncludeCount(request.nextUrl.searchParams.get('includeCount'));
  const parsedCursor = decodeCursor(request.nextUrl.searchParams.get('cursor'));

  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(brand)) {
    return NextResponse.json({
      data: {
        results: [] as FindingSearchResult[],
        nextCursor: null,
        hasMore: false,
        truncated: false,
        ...(includeCount ? { totalCount: 0 } : {}),
      },
    });
  }
  if (isBrandHistoryDeletionActive(brand)) {
    return NextResponse.json({
      data: {
        results: [] as FindingSearchResult[],
        nextCursor: null,
        hasMore: false,
        truncated: false,
        ...(includeCount ? { totalCount: 0 } : {}),
      },
    });
  }

  const deletingScanIds = new Set(await loadDeletingScanIdsForBrand({ brandId, userId: uid }));
  if (scanId && deletingScanIds.has(scanId)) {
    return NextResponse.json({
      data: {
        results: [] as FindingSearchResult[],
        nextCursor: null,
        hasMore: false,
        truncated: false,
        ...(includeCount ? { totalCount: 0 } : {}),
      },
    });
  }

  if (findingIds.length > 0) {
    const findingRefs = findingIds.map((findingId) => db.collection('findings').doc(findingId));
    const findingSnapshots = await db.getAll(...findingRefs);
    const findingById = new Map(
      findingSnapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [
          snapshot.id,
          {
            id: snapshot.id,
            ...(snapshot.data() as Omit<FindingSummary, 'id'>),
          } satisfies FindingSummary,
        ]),
    );

    const orderedFindings = findingIds
      .map((findingId) => findingById.get(findingId) ?? null)
      .filter((finding): finding is FindingSummary => (
        finding !== null
        && finding.brandId === brandId
        && !deletingScanIds.has(finding.scanId)
      ));

    const scanContextById = await loadScanContextById(
      Array.from(new Set(orderedFindings.map((finding) => finding.scanId))),
    );

    const results: FindingSearchResult[] = orderedFindings.map((finding) => {
      const scanContext = scanContextById.get(finding.scanId);
      return {
        ...finding,
        displayBucket: getFindingDisplayBucket(finding),
        ...(scanContext?.startedAt ? { scanStartedAt: scanContext.startedAt } : {}),
        ...(scanContext?.status ? { scanStatus: scanContext.status } : {}),
      };
    });

    return NextResponse.json({
      data: {
        results,
        nextCursor: null,
        hasMore: false,
        truncated: false,
        totalCount: results.length,
      },
    });
  }

  if (normalizedQuery.length < MIN_SEARCH_QUERY_LENGTH && !isFilterOnlyRequest) {
    return NextResponse.json({
      data: {
        results: [] as FindingSearchResult[],
        nextCursor: null,
        hasMore: false,
        truncated: false,
        ...(includeCount ? { totalCount: 0 } : {}),
      },
    });
  }

  let query: Query = db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid);

  if (scanId) {
    query = query.where('scanId', '==', scanId);
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
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');

  const collectedMatches: FindingSummary[] = [];
  const collectedMatchCursors: SearchCursor[] = [];
  let matchedCount = 0;
  let lastScannedCursor = parsedCursor;
  let scannedFindings = 0;
  let exhausted = false;

  while ((includeCount || collectedMatches.length < resultLimit + 1) && scannedFindings < MAX_SCANNED_FINDINGS) {
    let pageQuery = orderedQuery.limit(SEARCH_SCAN_BATCH_SIZE);
    if (lastScannedCursor) {
      pageQuery = pageQuery.startAfter(
        new Timestamp(lastScannedCursor.createdAtSeconds, lastScannedCursor.createdAtNanoseconds),
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

      const createdAt = finding.createdAt;
      lastScannedCursor = {
        createdAtSeconds: createdAt.seconds,
        createdAtNanoseconds: createdAt.nanoseconds,
        findingId: finding.id,
      };
      scannedFindings++;

      if (!deletingScanIds.has(finding.scanId) && matchesSearchFilters(finding, {
        normalizedQuery,
        categorySet,
        sourceSet,
        normalizedThemeSet,
        scope,
      })) {
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

    if (snapshot.size < SEARCH_SCAN_BATCH_SIZE) {
      exhausted = true;
      break;
    }
  }

  const sortedMatchEntries = collectedMatches
    .map((finding, index) => ({
      finding,
      cursor: collectedMatchCursors[index],
    }))
    .sort((left, right) => {
      const priorityDiff = getFindingSearchPriority(left.finding) - getFindingSearchPriority(right.finding);
      if (priorityDiff !== 0) return priorityDiff;

      const secondsDiff = right.finding.createdAt.seconds - left.finding.createdAt.seconds;
      if (secondsDiff !== 0) return secondsDiff;

      const nanosDiff = right.finding.createdAt.nanoseconds - left.finding.createdAt.nanoseconds;
      if (nanosDiff !== 0) return nanosDiff;

      return right.finding.id.localeCompare(left.finding.id);
    });

  const hasMore = sortedMatchEntries.length > resultLimit;
  const visibleMatchEntries = hasMore ? sortedMatchEntries.slice(0, resultLimit) : sortedMatchEntries;
  const visibleMatches = visibleMatchEntries.map((entry) => entry.finding);
  const visibleMatchCursors = visibleMatchEntries.map((entry) => entry.cursor);
  const nextCursor = hasMore && visibleMatchCursors.length > 0
    ? encodeCursor(visibleMatchCursors[visibleMatchCursors.length - 1])
    : null;
  const truncated = !hasMore && !exhausted && scannedFindings >= MAX_SCANNED_FINDINGS;
  const totalCount = includeCount && exhausted ? matchedCount : undefined;
  const scanContextById = await loadScanContextById(
    Array.from(new Set(visibleMatches.map((finding) => finding.scanId))),
  );

  const results: FindingSearchResult[] = visibleMatches.map((finding) => {
    const scanContext = scanContextById.get(finding.scanId);
    return {
      ...finding,
      displayBucket: getFindingDisplayBucket(finding),
      ...(scanContext?.startedAt ? { scanStartedAt: scanContext.startedAt } : {}),
      ...(scanContext?.status ? { scanStatus: scanContext.status } : {}),
    };
  });

  return NextResponse.json({
    data: {
      results,
      nextCursor,
      hasMore,
      truncated,
      ...(totalCount !== undefined ? { totalCount } : {}),
    },
  });
}
