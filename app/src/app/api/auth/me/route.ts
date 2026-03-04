import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken, AUTH_COOKIE_NAME } from '@/lib/auth/jwt';

export async function GET(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  return NextResponse.json({ userId: payload.userId, email: payload.email });
}
