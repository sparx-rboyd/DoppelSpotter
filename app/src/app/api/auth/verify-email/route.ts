import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from '@google-cloud/firestore';
import { verifyEmailVerificationToken, signToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { errorResponse } from '@/lib/api-utils';
import { db } from '@/lib/firestore';
import type { UserRecord } from '@/lib/types';

const INVALID_LINK_MESSAGE = 'This verification link is invalid or has expired.';

export async function POST(request: NextRequest) {
  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  const payload = verifyEmailVerificationToken(token);
  if (!payload) {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  const userRef = db.collection('users').doc(payload.userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  const userData = userDoc.data() as Pick<UserRecord, 'email' | 'sessionVersion' | 'emailVerified'>;

  // Guard against token reuse if the account email ever changes
  if (userData.email !== payload.email) {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  // Idempotent: clicking the link a second time still succeeds
  if (userData.emailVerified !== true) {
    await userRef.update({
      emailVerified: true,
      emailVerifiedAt: FieldValue.serverTimestamp(),
    });
  }

  const sessionVersion = userData.sessionVersion ?? 0;
  const authToken = signToken(payload.userId, payload.email, sessionVersion);

  const response = NextResponse.json({ userId: payload.userId, email: payload.email });
  response.cookies.set(AUTH_COOKIE_NAME, authToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });

  return response;
}
