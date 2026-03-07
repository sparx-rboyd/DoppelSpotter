import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken, AUTH_COOKIE_NAME } from './auth/jwt';
import { db } from './firestore';
import type { ApiError } from './types';

export function errorResponse(message: string, status: number = 400): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
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

  const userSessionVersion = (userDoc.data()?.sessionVersion as number | undefined) ?? 0;
  const tokenSessionVersion = payload.sessionVersion ?? 0;
  if (userSessionVersion !== tokenSessionVersion) {
    return { uid: null, email: null, error: errorResponse('Unauthorized', 401) };
  }

  return { uid: payload.userId, email: payload.email, error: null };
}
