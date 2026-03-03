import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { requireAuth } from '@/lib/api-utils';
import type { Finding } from '@/lib/types';

// GET /api/findings — latest findings across all of the authenticated user's brands
// Query params:
//   limit  (optional, default 20, max 100)
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const limitParam = request.nextUrl.searchParams.get('limit');
  const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100);

  const snapshot = await adminDb
    .collection('findings')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  if (snapshot.empty) {
    return NextResponse.json({ data: [] });
  }

  const findings: Finding[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Finding, 'id'>),
  }));

  return NextResponse.json({ data: findings });
}
