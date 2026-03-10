import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from '@google-cloud/firestore';
import { verifyToken, AUTH_COOKIE_NAME } from './auth/jwt';
import { db } from './firestore';
import type { UserRecord } from './types';
import type { ApiError } from './types';

const LAST_SEEN_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function errorResponse(message: string, status: number = 400): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

export async function setUserLastSeen(userId: string): Promise<void> {
  await db.collection('users').doc(userId).set({
    lastSeenAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Verify the auth cookie in the request.
 * Returns the userId from the JWT payload, or responds with 401 if invalid.
 */
export async function requireAuth(
  request: NextRequest,
): Promise<
  { uid: string; email: string; error: null } |
  { uid: null; email: null; error: NextResponse<ApiError> }
> {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return { uid: null, email: null, error: errorResponse('Unauthorized', 401) };

  const payload = verifyToken(token);
  if (!payload) return { uid: null, email: null, error: errorResponse('Unauthorized', 401) };

  const userDoc = await db.collection('users').doc(payload.userId).get();
  if (!userDoc.exists) {
    return { uid: null, email: null, error: errorResponse('Unauthorized', 401) };
  }

  const user = userDoc.data() as Pick<UserRecord, 'sessionVersion' | 'lastSeenAt'> | undefined;
  const userSessionVersion = user?.sessionVersion ?? 0;
  const tokenSessionVersion = payload.sessionVersion ?? 0;
  if (userSessionVersion !== tokenSessionVersion) {
    return { uid: null, email: null, error: errorResponse('Unauthorized', 401) };
  }

  const lastSeenAt = user?.lastSeenAt;
  if (!lastSeenAt || (Date.now() - lastSeenAt.toMillis()) >= LAST_SEEN_REFRESH_INTERVAL_MS) {
    try {
      await setUserLastSeen(payload.userId);
    } catch (error) {
      console.error(`[auth] Failed to update lastSeenAt for user ${payload.userId}`, error);
    }
  }

  return { uid: payload.userId, email: payload.email, error: null };
}
