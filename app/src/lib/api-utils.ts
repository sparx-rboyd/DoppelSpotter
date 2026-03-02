import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuthHeader } from './firebase/admin';
import type { ApiError } from './types';

export function errorResponse(message: string, status: number = 400): NextResponse<ApiError> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Verify the Bearer token in the request's Authorization header.
 * Returns the decoded token payload or responds with 401 if invalid.
 */
export async function requireAuth(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  const decoded = await verifyAuthHeader(authHeader);
  if (!decoded) return { uid: null, error: errorResponse('Unauthorized', 401) };
  return { uid: decoded.uid, error: null };
}
