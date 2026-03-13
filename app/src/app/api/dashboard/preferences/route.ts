import { FieldValue } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import { isBrandDeletionActive } from '@/lib/async-deletions';
import type { BrandProfile, DashboardPreferenceUpdateInput } from '@/lib/types';

// PATCH /api/dashboard/preferences
// Persists lightweight per-user dashboard state such as the selected brand.
export async function PATCH(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: DashboardPreferenceUpdateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'selectedBrandId')) {
    return errorResponse('selectedBrandId is required');
  }

  if (body.selectedBrandId !== null && typeof body.selectedBrandId !== 'string') {
    return errorResponse('selectedBrandId must be a string or null');
  }

  if (typeof body.selectedBrandId === 'string') {
    const brandDoc = await db.collection('brands').doc(body.selectedBrandId).get();
    if (!brandDoc.exists) return errorResponse('Brand not found', 404);
    const brand = brandDoc.data() as BrandProfile;
    if (brand.userId !== uid) return errorResponse('Forbidden', 403);
    if (isBrandDeletionActive(brand)) return errorResponse('Brand not found', 404);

    await db.collection('users').doc(uid).set({
      dashboardPreferences: {
        selectedBrandId: body.selectedBrandId,
      },
    }, { merge: true });
  } else {
    await db.collection('users').doc(uid).update({
      'dashboardPreferences.selectedBrandId': FieldValue.delete(),
    });
  }

  return NextResponse.json({
    data: {
      selectedBrandId: body.selectedBrandId,
    },
  });
}
