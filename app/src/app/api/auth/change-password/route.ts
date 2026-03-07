import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { FieldValue } from '@google-cloud/firestore';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import { signToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { db } from '@/lib/firestore';
import type { UserRecord } from '@/lib/types';

class ChangePasswordError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function POST(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return errorResponse('Current password and new password are required');
  }

  if (newPassword.length < 8) {
    return errorResponse('New password must be at least 8 characters');
  }

  if (currentPassword === newPassword) {
    return errorResponse('New password must be different from your current password');
  }

  const nextPasswordHash = await bcrypt.hash(newPassword, 12);

  try {
    const result = await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) {
        throw new ChangePasswordError('Account not found', 404);
      }

      const user = userDoc.data() as Pick<UserRecord, 'email' | 'passwordHash' | 'sessionVersion'>;
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        throw new ChangePasswordError('Current password is incorrect', 400);
      }

      const nextSessionVersion = (user.sessionVersion ?? 0) + 1;
      const normalizedEmail = user.email.trim().toLowerCase();

      tx.update(userRef, {
        passwordHash: nextPasswordHash,
        sessionVersion: nextSessionVersion,
        passwordChangedAt: FieldValue.serverTimestamp(),
      });

      return {
        email: normalizedEmail,
        sessionVersion: nextSessionVersion,
      };
    });

    const token = signToken(uid, result.email, result.sessionVersion);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;
  } catch (error) {
    if (error instanceof ChangePasswordError) {
      return errorResponse(error.message, error.status);
    }

    throw error;
  }
}
