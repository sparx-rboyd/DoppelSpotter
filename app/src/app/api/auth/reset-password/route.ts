import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { FieldValue } from '@google-cloud/firestore';
import { errorResponse } from '@/lib/api-utils';
import { verifyPasswordResetToken } from '@/lib/auth/jwt';
import { db } from '@/lib/firestore';
import type { UserRecord } from '@/lib/types';

const INVALID_RESET_LINK_MESSAGE = 'This password reset link is invalid or has expired.';

class ResetPasswordError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function POST(request: NextRequest) {
  let body: { token?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!token || !newPassword) {
    return errorResponse('Password reset token and new password are required');
  }

  if (newPassword.length < 8) {
    return errorResponse('New password must be at least 8 characters');
  }

  const payload = verifyPasswordResetToken(token);
  if (!payload) {
    return errorResponse(INVALID_RESET_LINK_MESSAGE, 400);
  }

  const nextPasswordHash = await bcrypt.hash(newPassword, 12);

  try {
    await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(payload.userId);
      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) {
        throw new ResetPasswordError(INVALID_RESET_LINK_MESSAGE, 400);
      }

      const user = userDoc.data() as Pick<UserRecord, 'email' | 'passwordHash' | 'sessionVersion'>;
      const currentSessionVersion = user.sessionVersion ?? 0;
      const normalizedEmail = user.email.trim().toLowerCase();

      if (currentSessionVersion !== (payload.sessionVersion ?? 0) || normalizedEmail !== payload.email) {
        throw new ResetPasswordError(INVALID_RESET_LINK_MESSAGE, 400);
      }

      const samePassword = await bcrypt.compare(newPassword, user.passwordHash);
      if (samePassword) {
        throw new ResetPasswordError('New password must be different from your current password', 400);
      }

      tx.update(userRef, {
        passwordHash: nextPasswordHash,
        sessionVersion: currentSessionVersion + 1,
        passwordChangedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    if (error instanceof ResetPasswordError) {
      return errorResponse(error.message, error.status);
    }

    throw error;
  }

  return NextResponse.json({ ok: true });
}
