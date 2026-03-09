import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { FieldValue } from '@google-cloud/firestore';
import { errorResponse } from '@/lib/api-utils';
import { signToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { normaliseEmail } from '@/lib/email-branding';
import { db } from '@/lib/firestore';
import { hashInviteCode, normalizeInviteCode } from '@/lib/invite-codes';
import { consumeSignupRateLimit } from '@/lib/signup-rate-limit';
import type { InviteCodeRecord } from '@/lib/types';

const INVALID_INVITE_CODE_MESSAGE = 'Invite code is invalid or has already been used.';

class SignupError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; inviteCode?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const normalizedEmail = normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const normalizedInviteCode = normalizeInviteCode(body.inviteCode);

  if (!normalizedEmail || !password || !body.inviteCode) {
    return errorResponse('Email, password, and invite code are required');
  }

  const rateLimitResult = await consumeSignupRateLimit(request);
  if (!rateLimitResult.ok) {
    const response = NextResponse.json(
      {
        error: 'Too many registration attempts. Please wait before trying again.',
        retryAfterSeconds: rateLimitResult.retryAfterSeconds,
      },
      { status: 429 },
    );
    response.headers.set('Retry-After', String(rateLimitResult.retryAfterSeconds ?? 1));
    return response;
  }

  if (!normalizedEmail.includes('@')) {
    return errorResponse('Invalid email address');
  }

  if (password.length < 8) {
    return errorResponse('Password must be at least 8 characters');
  }

  if (!normalizedInviteCode) {
    return errorResponse(INVALID_INVITE_CODE_MESSAGE, 400);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const inviteCodeHash = hashInviteCode(normalizedInviteCode);

  try {
    const result = await db.runTransaction(async (tx) => {
      const inviteRef = db.collection('inviteCodes').doc(inviteCodeHash);
      const inviteDoc = await tx.get(inviteRef);
      if (!inviteDoc.exists) {
        throw new SignupError(INVALID_INVITE_CODE_MESSAGE, 400);
      }

      const invite = inviteDoc.data() as InviteCodeRecord;
      if (invite.usedAt) {
        throw new SignupError(INVALID_INVITE_CODE_MESSAGE, 400);
      }

      const existingUsers = await tx.get(
        db.collection('users').where('email', '==', normalizedEmail).limit(1),
      );
      if (!existingUsers.empty) {
        throw new SignupError('An account with this email already exists.', 409);
      }

      const userRef = db.collection('users').doc();
      tx.set(userRef, {
        email: normalizedEmail,
        passwordHash,
        sessionVersion: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(inviteRef, {
        usedAt: FieldValue.serverTimestamp(),
        usedByEmail: normalizedEmail,
        usedByUserId: userRef.id,
      });

      return { userId: userRef.id };
    });

    const token = signToken(result.userId, normalizedEmail, 0);
    const response = NextResponse.json({ userId: result.userId, email: normalizedEmail });
    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;
  } catch (error) {
    if (error instanceof SignupError) {
      return errorResponse(error.message, error.status);
    }

    throw error;
  }
}
