import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth } from '@/lib/api-utils';
import type { UserPreferences, UserRecord } from '@/lib/types';

export async function GET(request: NextRequest) {
  const { uid, email, error } = await requireAuth(request);
  if (error) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  const userDoc = await db.collection('users').doc(uid).get();
  const preferences = (userDoc.data() as UserRecord | undefined)?.preferences as UserPreferences | undefined;

  return NextResponse.json({ userId: uid, email, preferences: preferences ?? {} });
}
