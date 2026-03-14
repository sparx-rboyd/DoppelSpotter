import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import { drainAccountDeletion, isAccountDeletionActive, markAccountDeletionQueued } from '@/lib/async-deletions';
import { scheduleDeletionTaskOrRunInline } from '@/lib/deletion-tasks';
import { db } from '@/lib/firestore';
import type { UserRecord } from '@/lib/types';

export async function DELETE(request: NextRequest) {
  const { uid, error } = await requireAuth(request, { allowAccountDeletion: true });
  if (error) return error;

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnapshot = await userRef.get();
    if (!userSnapshot.exists) {
      const response = new NextResponse(null, { status: 202 });
      response.cookies.set(AUTH_COOKIE_NAME, '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      });
      return response;
    }

    const user = userSnapshot.data() as UserRecord;
    if (!isAccountDeletionActive(user)) {
      await markAccountDeletionQueued(uid);
    }

    await scheduleDeletionTaskOrRunInline({
      payload: {
        kind: 'account',
        userId: uid,
      },
      requestHeaders: request.headers,
      logPrefix: `[account-delete] User ${uid}`,
      runInline: () => drainAccountDeletion({ userId: uid }),
    });

    const response = new NextResponse(null, { status: 202 });

    response.cookies.set(AUTH_COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('[account-delete] Failed to delete account:', error);
    return errorResponse('Failed to delete account', 500);
  }
}
