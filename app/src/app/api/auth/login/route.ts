import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/firestore';
import { signToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { errorResponse } from '@/lib/api-utils';
import type { UserRecord } from '@/lib/types';

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { email, password } = body;

  if (!email || !password) {
    return errorResponse('Email and password are required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const snapshot = await db
    .collection('users')
    .where('email', '==', normalizedEmail)
    .limit(1)
    .get();

  if (snapshot.empty) {
    // Return the same error as wrong password to avoid user enumeration
    return errorResponse('Invalid email or password', 401);
  }

  const userDoc = snapshot.docs[0];
  const user = userDoc.data() as Pick<UserRecord, 'email' | 'passwordHash' | 'sessionVersion'>;
  const { passwordHash } = user;

  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    return errorResponse('Invalid email or password', 401);
  }

  const sessionVersion = user.sessionVersion ?? 0;
  const token = signToken(userDoc.id, normalizedEmail, sessionVersion);

  const response = NextResponse.json({ userId: userDoc.id, email: normalizedEmail });

  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });

  return response;
}
