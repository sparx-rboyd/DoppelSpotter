import { NextResponse, type NextRequest } from 'next/server';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import { verifyToken, AUTH_COOKIE_NAME } from './auth/jwt';
import { isAccountDeletionActive } from './async-deletions';
import { db } from './firestore';
import type { UserRecord } from './types';
import type { ApiError } from './types';

const LAST_SEEN_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
type AuthUserState = Pick<UserRecord, 'sessionVersion' | 'lastSeenAt' | 'accountDeletion'>;

export function errorResponse(message: string, status: number = 400): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

function unauthorizedResponse(clearAuthCookie = false): NextResponse<ApiError> {
  const response = errorResponse('Unauthorized', 401);

  if (clearAuthCookie) {
    response.cookies.set(AUTH_COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
  }

  return response;
}

export async function setUserLastSeen(userId: string): Promise<void> {
  await db.collection('users').doc(userId).set({
    lastSeenAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function loadAuthUserState(userId: string): Promise<AuthUserState | null> {
  const userQuerySnapshot = await db
    .collection('users')
    .where(FieldPath.documentId(), '==', userId)
    .select('sessionVersion', 'lastSeenAt', 'accountDeletion')
    .limit(1)
    .get();

  if (userQuerySnapshot.empty) {
    return null;
  }

  return userQuerySnapshot.docs[0].data() as AuthUserState;
}

/**
 * Verify the auth cookie in the request.
 * Returns the userId from the JWT payload, or responds with 401 if invalid.
 */
export async function requireAuth(
  request: NextRequest,
  options?: {
    allowAccountDeletion?: boolean;
  },
): Promise<
  { uid: string; email: string; error: null } |
  { uid: null; email: null; error: NextResponse<ApiError> }
> {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return { uid: null, email: null, error: unauthorizedResponse() };

  const payload = verifyToken(token);
  if (!payload) return { uid: null, email: null, error: unauthorizedResponse(true) };

  const user = await loadAuthUserState(payload.userId);
  if (!user) {
    return { uid: null, email: null, error: unauthorizedResponse(true) };
  }

  const userSessionVersion = user?.sessionVersion ?? 0;
  const tokenSessionVersion = payload.sessionVersion ?? 0;
  if (userSessionVersion !== tokenSessionVersion) {
    return { uid: null, email: null, error: unauthorizedResponse(true) };
  }

  if (!options?.allowAccountDeletion && isAccountDeletionActive(user)) {
    return { uid: null, email: null, error: unauthorizedResponse(true) };
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
