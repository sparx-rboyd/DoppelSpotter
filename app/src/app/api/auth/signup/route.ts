import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/firestore';
import { signToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { email, password } = body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return errorResponse('A valid email address is required');
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return errorResponse('Password must be at least 8 characters');
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check if email is already taken
  const existing = await db
    .collection('users')
    .where('email', '==', normalizedEmail)
    .limit(1)
    .get();

  if (!existing.empty) {
    return errorResponse('An account with this email already exists', 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userRef = db.collection('users').doc();

  await userRef.set({
    email: normalizedEmail,
    passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });

  const token = signToken(userRef.id, normalizedEmail);

  const response = NextResponse.json(
    { userId: userRef.id, email: normalizedEmail },
    { status: 201 },
  );

  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });

  return response;
}
