import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const { uid, email, error } = await requireAuth(request);
  if (error) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  }

  return NextResponse.json({ userId: uid, email });
}
