import { FieldValue } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth } from '@/lib/api-utils';
import {
  drainBrandDeletion,
  drainBrandHistoryDeletion,
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
  isScanDeletionActive,
} from '@/lib/async-deletions';
import type { BrandProfile, BrandSummary, DashboardBootstrapData, Scan, UserRecord } from '@/lib/types';

const TERMINAL_SCAN_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const IN_PROGRESS_SCAN_STATUSES = new Set(['pending', 'running', 'summarising']);

// GET /api/dashboard/bootstrap
// Returns brand picker options plus the persisted default dashboard brand selection.
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;
  void request;

  const userRef = db.collection('users').doc(uid);
  const [userDoc, brandSnapshot, scanSnapshot] = await Promise.all([
    userRef.get(),
    db
      .collection('brands')
      .where('userId', '==', uid)
      .select('name', 'createdAt', 'scanSchedule')
      .orderBy('createdAt', 'asc')
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

    if (IN_PROGRESS_SCAN_STATUSES.has(scan.status)) {
      current.isScanInProgress = true;
    }

    if (!TERMINAL_SCAN_STATUSES.has(scan.status)) {
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

  const user = userDoc.data() as UserRecord | undefined;
  const preferredBrandId = user?.dashboardPreferences?.selectedBrandId;
  const hasPreferredBrand = Boolean(preferredBrandId && brands.some((brand) => brand.id === preferredBrandId));
  const selectedBrandId = hasPreferredBrand
    ? preferredBrandId ?? null
    : (brands[0]?.id ?? null);

  if (selectedBrandId !== preferredBrandId) {
    if (selectedBrandId) {
      await userRef.set({
        dashboardPreferences: { selectedBrandId },
      }, { merge: true });
    } else if (preferredBrandId) {
      await userRef.update({
        'dashboardPreferences.selectedBrandId': FieldValue.delete(),
      });
    }
  }

  const data: DashboardBootstrapData = {
    brands,
    selectedBrandId,
  };

  return NextResponse.json({ data });
}
