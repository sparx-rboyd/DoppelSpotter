import { FieldValue } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth } from '@/lib/api-utils';
import {
  isBrandDeletionActive,
  isBrandHistoryDeletionActive,
} from '@/lib/async-deletions';
import type { BrandProfile, DashboardBootstrapBrand, DashboardBootstrapData, UserRecord } from '@/lib/types';

// GET /api/dashboard/bootstrap
// Returns brand picker options plus the persisted default dashboard brand selection.
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;
  void request;

  const userRef = db.collection('users').doc(uid);
  const [userDoc, brandSnapshot] = await Promise.all([
    userRef.get(),
    db
      .collection('brands')
      .where('userId', '==', uid)
      .select('name', 'createdAt', 'scanSchedule', 'historyDeletion', 'brandDeletion')
      .orderBy('createdAt', 'asc')
      .get(),
  ]);

  const brands = brandSnapshot.docs.reduce<DashboardBootstrapBrand[]>((acc, doc) => {
      const data = doc.data() as Pick<BrandProfile, 'name' | 'createdAt' | 'scanSchedule' | 'historyDeletion' | 'brandDeletion'>;
      if (isBrandDeletionActive(data)) {
        return acc;
      }
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
        isHistoryDeletionInProgress: isBrandHistoryDeletionActive(data),
        scanSchedule,
        createdAt: data.createdAt,
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
