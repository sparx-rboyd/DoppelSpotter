import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import {
  hasCustomBrandAnalysisSeverityDefinitions,
  isValidBrandAnalysisSeverityDefinitions,
  normalizeBrandAnalysisSeverityDefinitions,
} from '@/lib/analysis-severity';
import {
  drainBrandDeletion,
  drainBrandHistoryDeletion,
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  isScanDeletionActive,
} from '@/lib/async-deletions';
import {
  DEFAULT_LOOKBACK_PERIOD,
  DEFAULT_SEARCH_RESULT_PAGES,
  DEFAULT_ALLOW_AI_DEEP_SEARCHES,
  DEFAULT_BRAND_SCAN_SOURCES,
  hasEnabledBrandScanSource,
  isValidLookbackPeriod,
  isValidSearchResultPages,
  isValidAllowAiDeepSearches,
  isValidBrandScanSources,
  DEFAULT_MAX_AI_DEEP_SEARCHES,
  MAX_BRAND_KEYWORDS,
  MAX_AI_DEEP_SEARCHES,
  MAX_SEARCH_RESULT_PAGES,
  MIN_AI_DEEP_SEARCHES,
  MIN_SEARCH_RESULT_PAGES,
  isValidMaxAiDeepSearches,
  normalizeBrandScanSources,
} from '@/lib/brands';
import type { BrandProfile, BrandProfileCreateInput, BrandSummary, Scan, ScanStatus } from '@/lib/types';
import { buildBrandScanSchedule, isScheduleStartInPast } from '@/lib/scan-schedules';

const TERMINAL_SCAN_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];
const IN_PROGRESS_SCAN_STATUSES: ScanStatus[] = ['pending', 'running', 'summarising'];

// GET /api/brands — list all brands for the authenticated user
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;
  void request;

  const [brandSnapshot, scanSnapshot] = await Promise.all([
    db
      .collection('brands')
      .where('userId', '==', uid)
      .select('name', 'createdAt', 'scanSchedule', 'historyDeletion', 'brandDeletion')
      .orderBy('createdAt', 'desc')
      .get(),
    db
      .collection('scans')
      .where('userId', '==', uid)
      .select('brandId', 'status', 'startedAt', 'highCount', 'mediumCount', 'lowCount', 'nonHitCount', 'deletion')
      .get(),
  ]);

  const countsByBrandId = new Map<
    string,
    Pick<BrandSummary, 'scanCount' | 'findingCount' | 'nonHitCount' | 'isScanInProgress' | 'lastScanStartedAt'>
  >();

  for (const doc of scanSnapshot.docs) {
    const scan = doc.data() as Pick<Scan, 'brandId' | 'status' | 'startedAt' | 'highCount' | 'mediumCount' | 'lowCount' | 'nonHitCount' | 'deletion'>;
    if (isScanDeletionActive(scan)) {
      continue;
    }

    const current = countsByBrandId.get(scan.brandId) ?? {
      scanCount: 0,
      findingCount: 0,
      nonHitCount: 0,
      isScanInProgress: false,
      lastScanStartedAt: undefined,
    };

    if (!current.lastScanStartedAt || scan.startedAt.toMillis() > current.lastScanStartedAt.toMillis()) {
      current.lastScanStartedAt = scan.startedAt;
    }

    if (IN_PROGRESS_SCAN_STATUSES.includes(scan.status)) {
      current.isScanInProgress = true;
    }

    if (!TERMINAL_SCAN_STATUSES.includes(scan.status)) {
      countsByBrandId.set(scan.brandId, current);
      continue;
    }

    current.scanCount += 1;
    current.findingCount += (scan.highCount ?? 0) + (scan.mediumCount ?? 0) + (scan.lowCount ?? 0);
    current.nonHitCount += scan.nonHitCount ?? 0;

    countsByBrandId.set(scan.brandId, current);
  }

  const brands = brandSnapshot.docs.reduce<BrandSummary[]>((acc, doc) => {
      const data = doc.data() as Pick<BrandProfile, 'name' | 'createdAt' | 'scanSchedule' | 'historyDeletion' | 'brandDeletion'>;
      if (isBrandDeletionActive(data)) {
        void drainBrandDeletion({ brandId: doc.id, userId: uid }).catch(() => {
          // Non-critical
        });
        return acc;
      }

      if (isBrandHistoryDeletionActive(data)) {
        void drainBrandHistoryDeletion({ brandId: doc.id, userId: uid }).catch(() => {
          // Non-critical
        });
      }

      const counts = countsByBrandId.get(doc.id);
      const scanSchedule = data.scanSchedule?.enabled
        ? {
            enabled: data.scanSchedule.enabled,
            timeZone: data.scanSchedule.timeZone,
            nextRunAt: data.scanSchedule.nextRunAt,
          }
        : undefined;

      acc.push({
        id: doc.id,
        name: data.name,
        scanCount: isBrandHistoryDeletionActive(data) ? 0 : (counts?.scanCount ?? 0),
        findingCount: isBrandHistoryDeletionActive(data) ? 0 : (counts?.findingCount ?? 0),
        nonHitCount: isBrandHistoryDeletionActive(data) ? 0 : (counts?.nonHitCount ?? 0),
        isScanInProgress: counts?.isScanInProgress ?? false,
        isHistoryDeletionInProgress: isBrandHistoryDeletionActive(data),
        scanSchedule,
        createdAt: data.createdAt,
        ...(counts?.lastScanStartedAt ? { lastScanStartedAt: counts.lastScanStartedAt } : {}),
      });

      return acc;
    }, []);

  return NextResponse.json({ data: brands });
}

// POST /api/brands — create a new brand profile
export async function POST(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: BrandProfileCreateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const {
    name,
    keywords = [],
    officialDomains = [],
    searchResultPages = DEFAULT_SEARCH_RESULT_PAGES,
    lookbackPeriod = DEFAULT_LOOKBACK_PERIOD,
    sendScanSummaryEmails = true,
    watchWords = [],
    safeWords = [],
    allowAiDeepSearches = DEFAULT_ALLOW_AI_DEEP_SEARCHES,
    maxAiDeepSearches = DEFAULT_MAX_AI_DEEP_SEARCHES,
    scanSources = DEFAULT_BRAND_SCAN_SOURCES,
    analysisSeverityDefinitions = {},
    scanSchedule,
  } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse('Brand name is required');
  }

  if (!Array.isArray(keywords)) {
    return errorResponse('keywords must be an array of strings');
  }

  const normalizedKeywords = keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  if (normalizedKeywords.length > MAX_BRAND_KEYWORDS) {
    return errorResponse(`You can add up to ${MAX_BRAND_KEYWORDS} protected keywords`);
  }

  if (!isValidAllowAiDeepSearches(allowAiDeepSearches)) {
    return errorResponse('allowAiDeepSearches must be a boolean');
  }

  if (!isValidSearchResultPages(searchResultPages)) {
    return errorResponse(
      `searchResultPages must be a whole number from ${MIN_SEARCH_RESULT_PAGES} to ${MAX_SEARCH_RESULT_PAGES}`,
    );
  }

  if (!isValidLookbackPeriod(lookbackPeriod)) {
    return errorResponse('lookbackPeriod must be one of: 1year, 1month, 1week, since_last_scan');
  }

  if (typeof sendScanSummaryEmails !== 'boolean') {
    return errorResponse('sendScanSummaryEmails must be a boolean');
  }

  if (!isValidMaxAiDeepSearches(maxAiDeepSearches)) {
    return errorResponse(
      `maxAiDeepSearches must be a whole number from ${MIN_AI_DEEP_SEARCHES} to ${MAX_AI_DEEP_SEARCHES}`,
    );
  }
  if (!isValidBrandScanSources(scanSources)) {
    return errorResponse('scanSources must include boolean google, reddit, tiktok, youtube, facebook, instagram, telegram, apple_app_store, google_play, domains, discord, github, and x values');
  }
  if (!isValidBrandAnalysisSeverityDefinitions(analysisSeverityDefinitions)) {
    return errorResponse('analysisSeverityDefinitions must include optional high, medium, and low strings up to 1500 characters');
  }
  if (!hasEnabledBrandScanSource(scanSources)) {
    return errorResponse('At least one scan source must be enabled');
  }
  if (scanSchedule?.enabled && isScheduleStartInPast(scanSchedule)) {
    return errorResponse('Scheduled scan start date and time must be in the future');
  }

  let resolvedScanSchedule;
  try {
    resolvedScanSchedule = scanSchedule ? buildBrandScanSchedule(scanSchedule) : undefined;
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid scan schedule');
  }

  const docRef = db.collection('brands').doc();
  const now = FieldValue.serverTimestamp();
  const nowDate = new Date();

  const brandData = {
    userId: uid,
    name: name.trim(),
    keywords: normalizedKeywords,
    officialDomains: officialDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean),
    searchResultPages,
    lookbackPeriod,
    sendScanSummaryEmails,
    allowAiDeepSearches,
    maxAiDeepSearches,
    scanSources: normalizeBrandScanSources(scanSources),
    ...(hasCustomBrandAnalysisSeverityDefinitions(analysisSeverityDefinitions)
      ? { analysisSeverityDefinitions: normalizeBrandAnalysisSeverityDefinitions(analysisSeverityDefinitions) }
      : {}),
    watchWords: (watchWords as string[]).map((w) => String(w).trim().toLowerCase()).filter(Boolean),
    safeWords: (safeWords as string[]).map((w) => String(w).trim().toLowerCase()).filter(Boolean),
    ...(resolvedScanSchedule ? { scanSchedule: resolvedScanSchedule } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(brandData);

  // Return JS Dates in the response — FieldValue.serverTimestamp() is a write sentinel
  // that only resolves inside Firestore and cannot be serialised directly.
  return NextResponse.json({
    data: { id: docRef.id, ...brandData, createdAt: nowDate, updatedAt: nowDate },
  }, { status: 201 });
}
