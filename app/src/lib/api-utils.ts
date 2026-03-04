import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken, AUTH_COOKIE_NAME } from './auth/jwt';
import type { ApiError } from './types';

export function errorResponse(message: string, status: number = 400): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Verify the auth cookie in the request.
 * Returns the userId from the JWT payload, or responds with 401 if invalid.
 */
export function requireAuth(request: NextRequest): { uid: string; error: null } | { uid: null; error: NextResponse<ApiError> } {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return { uid: null, error: errorResponse('Unauthorized', 401) };

  const payload = verifyToken(token);
  if (!payload) return { uid: null, error: errorResponse('Unauthorized', 401) };

  return { uid: payload.userId, error: null };
}
