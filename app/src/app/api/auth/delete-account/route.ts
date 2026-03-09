import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth/jwt';
import { errorResponse, requireAuth } from '@/lib/api-utils';
import { deleteAccountAndOwnedData } from '@/lib/account-deletion';

export async function DELETE(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  try {
    const result = await deleteAccountAndOwnedData(uid);
    const response = NextResponse.json({
      ok: true,
      cancelledScanCount: result.cancelledScanCount,
      abortedRunCount: result.abortedRunCount,
    });

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
