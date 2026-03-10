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
  markBrandDeletionQueued,
} from '@/lib/async-deletions';
import {
  hasEnabledBrandScanSource,
  isValidAllowAiDeepSearches,
  isValidBrandScanSources,
  isValidLookbackPeriod,
  isValidMaxAiDeepSearches,
  isValidSearchResultPages,
  MAX_AI_DEEP_SEARCHES,
  MAX_SEARCH_RESULT_PAGES,
  MIN_AI_DEEP_SEARCHES,
  MIN_SEARCH_RESULT_PAGES,
  normalizeBrandScanSources,
} from '@/lib/brands';
import { isScanInProgress, scanFromSnapshot } from '@/lib/scans';
import {
  buildBrandScanSchedule,
  getScheduleInputFromBrandSchedule,
  isScheduleStartInPast,
} from '@/lib/scan-schedules';
import type { BrandProfile, BrandProfileUpdateInput } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const doc = await db.collection('brands').doc(brandId).get();

  if (!doc.exists) return errorResponse('Brand not found', 404);

  const data = doc.data() as Omit<BrandProfile, 'id'>;
  if (data.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(data)) {
    void drainBrandDeletion({ brandId, userId: uid }).catch((error) => {
      console.error(`[brand-delete] Failed to continue deletion for brand ${brandId}:`, error);
    });
    return errorResponse('Brand not found', 404);
  }
  if (isBrandHistoryDeletionActive(data)) {
    void drainBrandHistoryDeletion({ brandId, userId: uid }).catch((error: unknown) => {
      console.error(`[brand-history-delete] Failed to continue deletion for brand ${brandId}:`, error);
    });
  }

  return NextResponse.json({ data: { id: doc.id, ...data } });
}

// PATCH /api/brands/[brandId]
export async function PATCH(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const doc = await db.collection('brands').doc(brandId).get();

  if (!doc.exists) return errorResponse('Brand not found', 404);
  const existingBrand = doc.data() as BrandProfile;
  if (existingBrand.userId !== uid) return errorResponse('Forbidden', 403);
  if (isBrandDeletionActive(existingBrand)) return errorResponse('Brand not found', 404);
  if (isBrandHistoryDeletionActive(existingBrand)) {
    return errorResponse('Cannot update a brand while its history is being deleted', 409);
  }

  let body: BrandProfileUpdateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const updatedAt = new Date();
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (body.name) updates.name = body.name.trim();
  if (body.keywords) updates.keywords = body.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (body.officialDomains) updates.officialDomains = body.officialDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (body.sendScanSummaryEmails !== undefined) {
    if (typeof body.sendScanSummaryEmails !== 'boolean') {
      return errorResponse('sendScanSummaryEmails must be a boolean');
    }
    updates.sendScanSummaryEmails = body.sendScanSummaryEmails;
  }
  if (body.searchResultPages !== undefined) {
    if (!isValidSearchResultPages(body.searchResultPages)) {
      return errorResponse(
        `searchResultPages must be a whole number from ${MIN_SEARCH_RESULT_PAGES} to ${MAX_SEARCH_RESULT_PAGES}`,
      );
    }
    updates.searchResultPages = body.searchResultPages;
  }
  if (body.lookbackPeriod !== undefined) {
    if (!isValidLookbackPeriod(body.lookbackPeriod)) {
      return errorResponse('lookbackPeriod must be one of: 1year, 1month, 1week, since_last_scan');
    }
    updates.lookbackPeriod = body.lookbackPeriod;
  }
  if (body.allowAiDeepSearches !== undefined) {
    if (!isValidAllowAiDeepSearches(body.allowAiDeepSearches)) {
      return errorResponse('allowAiDeepSearches must be a boolean');
    }
    updates.allowAiDeepSearches = body.allowAiDeepSearches;
  }
  if (body.maxAiDeepSearches !== undefined) {
    if (!isValidMaxAiDeepSearches(body.maxAiDeepSearches)) {
      return errorResponse(
        `maxAiDeepSearches must be a whole number from ${MIN_AI_DEEP_SEARCHES} to ${MAX_AI_DEEP_SEARCHES}`,
      );
    }
    updates.maxAiDeepSearches = body.maxAiDeepSearches;
  }
  if (body.scanSources !== undefined) {
    if (!isValidBrandScanSources(body.scanSources)) {
      return errorResponse('scanSources must include boolean google, reddit, tiktok, youtube, facebook, instagram, telegram, apple_app_store, google_play, domains, discord, github, and x values');
    }
    if (!hasEnabledBrandScanSource(body.scanSources)) {
      return errorResponse('At least one scan source must be enabled');
    }
    updates.scanSources = normalizeBrandScanSources(body.scanSources);
  }
  if (body.analysisSeverityDefinitions !== undefined) {
    if (!isValidBrandAnalysisSeverityDefinitions(body.analysisSeverityDefinitions)) {
      return errorResponse('analysisSeverityDefinitions must include optional high, medium, and low strings up to 1500 characters');
    }

    updates.analysisSeverityDefinitions = hasCustomBrandAnalysisSeverityDefinitions(body.analysisSeverityDefinitions)
      ? normalizeBrandAnalysisSeverityDefinitions(body.analysisSeverityDefinitions)
      : FieldValue.delete();
  }
  if (body.watchWords !== undefined) updates.watchWords = body.watchWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (body.safeWords !== undefined) updates.safeWords = body.safeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (body.scanSchedule !== undefined) {
    const existingScheduleInput = existingBrand.scanSchedule
      ? getScheduleInputFromBrandSchedule(existingBrand.scanSchedule)
      : null;
    const isKeepingExistingPastStart = Boolean(
      existingScheduleInput?.enabled &&
      body.scanSchedule.timeZone === existingScheduleInput.timeZone &&
      body.scanSchedule.startDate === existingScheduleInput.startDate &&
      body.scanSchedule.startTime === existingScheduleInput.startTime,
    );

    if (body.scanSchedule.enabled && isScheduleStartInPast(body.scanSchedule) && !isKeepingExistingPastStart) {
      return errorResponse('Scheduled scan start date and time must be in the future');
    }

    try {
      updates.scanSchedule = buildBrandScanSchedule(body.scanSchedule);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Invalid scan schedule');
    }
  }

  await db.collection('brands').doc(brandId).update(updates);
  const responseData: Record<string, unknown> = { id: brandId, ...doc.data(), ...updates, updatedAt };

  if (updates.analysisSeverityDefinitions === FieldValue.delete()) {
    delete responseData.analysisSeverityDefinitions;
  }

  // Substitute a real Date for the sentinel so the response is serialisable
  return NextResponse.json({ data: responseData });
}

// DELETE /api/brands/[brandId]
export async function DELETE(request: NextRequest, { params }: Params) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const brandRef = db.collection('brands').doc(brandId);
  const doc = await brandRef.get();

  if (!doc.exists) return errorResponse('Brand not found', 404);
  const brand = doc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);

  if (isBrandDeletionActive(brand)) {
    void drainBrandDeletion({ brandId, userId: uid }).catch((error) => {
      console.error(`[brand-delete] Failed to continue deletion for brand ${brandId}:`, error);
    });
    return new NextResponse(null, { status: 202 });
  }

  const scanSnapshot = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .get();

  const activeScan = scanSnapshot.docs
    .map(scanFromSnapshot)
    .find((scan) => isScanInProgress(scan.status));

  if (activeScan) {
    return errorResponse('Cannot delete a brand while a scan is still in progress', 409);
  }

  await markBrandDeletionQueued(brandId);
  void drainBrandDeletion({ brandId, userId: uid }).catch((error) => {
    console.error(`[brand-delete] Failed to process deletion for brand ${brandId}:`, error);
  });

  return new NextResponse(null, { status: 202 });
}
