import { NextResponse, type NextRequest } from 'next/server';
import { FieldValue } from '@google-cloud/firestore';
import { verifyEmailVerificationToken } from '@/lib/auth/jwt';
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

  if (
    typeof payload.sessionVersion !== 'number' ||
    typeof payload.emailVerificationVersion !== 'number'
  ) {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  try {
    await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(payload.userId);
      const userDoc = await tx.get(userRef);

      if (!userDoc.exists) {
        throw new Error(INVALID_LINK_MESSAGE);
      }

      const userData = userDoc.data() as Pick<
        UserRecord,
        'email' | 'sessionVersion' | 'emailVerified' | 'emailVerificationVersion'
      >;

      const userSessionVersion = userData.sessionVersion ?? 0;
      const userEmailVerificationVersion = userData.emailVerificationVersion ?? 0;

      if (
        userData.email !== payload.email ||
        userData.emailVerified === true ||
        userSessionVersion !== payload.sessionVersion ||
        userEmailVerificationVersion !== payload.emailVerificationVersion
      ) {
        throw new Error(INVALID_LINK_MESSAGE);
      }

      tx.update(userRef, {
        emailVerified: true,
        emailVerifiedAt: FieldValue.serverTimestamp(),
        emailVerificationVersion: userEmailVerificationVersion + 1,
      });
    });
  } catch {
    return errorResponse(INVALID_LINK_MESSAGE, 400);
  }

  return NextResponse.json({ ok: true, email: payload.email });
}
