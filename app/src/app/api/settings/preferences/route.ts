import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import type { UserPreferences, UserRecord } from '@/lib/types';

interface SettingsPreferenceUpdateInput {
  skipDomainRegistrationVisitWarning?: boolean;
}

export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const userDoc = await db.collection('users').doc(uid).get();
  const preferences = (userDoc.data() as UserRecord | undefined)?.preferences as UserPreferences | undefined;

  return NextResponse.json({
    data: {
      skipDomainRegistrationVisitWarning: preferences?.skipDomainRegistrationVisitWarning === true,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: SettingsPreferenceUpdateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  if (typeof body.skipDomainRegistrationVisitWarning !== 'boolean') {
    return errorResponse('skipDomainRegistrationVisitWarning must be a boolean');
  }

  await db.collection('users').doc(uid).set({
    preferences: {
      skipDomainRegistrationVisitWarning: body.skipDomainRegistrationVisitWarning,
    },
  }, { merge: true });

  return NextResponse.json({
    data: {
      skipDomainRegistrationVisitWarning: body.skipDomainRegistrationVisitWarning,
    },
  });
}
