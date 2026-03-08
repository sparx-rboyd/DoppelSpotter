import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import {
  DEFAULT_SEARCH_RESULT_PAGES,
  DEFAULT_ALLOW_AI_DEEP_SEARCHES,
  DEFAULT_BRAND_SCAN_SOURCES,
  hasEnabledBrandScanSource,
  isValidSearchResultPages,
  isValidAllowAiDeepSearches,
  isValidBrandScanSources,
  DEFAULT_MAX_AI_DEEP_SEARCHES,
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
      .select('name', 'createdAt', 'scanSchedule')
      .orderBy('createdAt', 'desc')
      .get(),
    db
      .collection('scans')
      .where('userId', '==', uid)
      .select('brandId', 'status', 'startedAt', 'highCount', 'mediumCount', 'lowCount', 'nonHitCount')
      .get(),
  ]);

  const countsByBrandId = new Map<
    string,
    Pick<BrandSummary, 'scanCount' | 'findingCount' | 'nonHitCount' | 'isScanInProgress' | 'lastScanStartedAt'>
  >();

  for (const doc of scanSnapshot.docs) {
    const scan = doc.data() as Pick<Scan, 'brandId' | 'status' | 'startedAt' | 'highCount' | 'mediumCount' | 'lowCount' | 'nonHitCount'>;
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

  const brands: BrandSummary[] = brandSnapshot.docs.map((doc) => {
    const data = doc.data() as Pick<BrandProfile, 'name' | 'createdAt' | 'scanSchedule'>;
    const counts = countsByBrandId.get(doc.id);
    const scanSchedule = data.scanSchedule?.enabled
      ? {
          enabled: data.scanSchedule.enabled,
          timeZone: data.scanSchedule.timeZone,
          nextRunAt: data.scanSchedule.nextRunAt,
        }
      : undefined;

    return {
      id: doc.id,
      name: data.name,
      scanCount: counts?.scanCount ?? 0,
      findingCount: counts?.findingCount ?? 0,
      nonHitCount: counts?.nonHitCount ?? 0,
      isScanInProgress: counts?.isScanInProgress ?? false,
      lastScanStartedAt: counts?.lastScanStartedAt,
      scanSchedule,
      createdAt: data.createdAt,
    };
  });

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
    sendScanSummaryEmails = true,
    watchWords = [],
    safeWords = [],
    allowAiDeepSearches = DEFAULT_ALLOW_AI_DEEP_SEARCHES,
    maxAiDeepSearches = DEFAULT_MAX_AI_DEEP_SEARCHES,
    scanSources = DEFAULT_BRAND_SCAN_SOURCES,
    scanSchedule,
  } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse('Brand name is required');
  }

  if (!isValidAllowAiDeepSearches(allowAiDeepSearches)) {
    return errorResponse('allowAiDeepSearches must be a boolean');
  }

  if (!isValidSearchResultPages(searchResultPages)) {
    return errorResponse('searchResultPages must be a whole number from 1 to 10');
  }

  if (typeof sendScanSummaryEmails !== 'boolean') {
    return errorResponse('sendScanSummaryEmails must be a boolean');
  }

  if (!isValidMaxAiDeepSearches(maxAiDeepSearches)) {
    return errorResponse('maxAiDeepSearches must be a whole number from 1 to 10');
  }
  if (!isValidBrandScanSources(scanSources)) {
    return errorResponse('scanSources must include boolean google, reddit, tiktok, youtube, facebook, and instagram values');
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
    keywords: keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    officialDomains: officialDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean),
    searchResultPages,
    sendScanSummaryEmails,
    allowAiDeepSearches,
    maxAiDeepSearches,
    scanSources: normalizeBrandScanSources(scanSources),
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
