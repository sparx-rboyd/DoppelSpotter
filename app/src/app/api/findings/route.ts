import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth } from '@/lib/api-utils';
import type { Finding } from '@/lib/types';

// GET /api/findings — latest findings across all of the authenticated user's brands
// Query params:
//   limit        (optional, default 20, max 100)
//   nonHitsOnly  (optional) — when "true", returns only LLM false-positives; otherwise returns only real findings
export async function GET(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const limitParam = request.nextUrl.searchParams.get('limit');
  const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100);
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';

  const snapshot = await db
    .collection('findings')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit * 4)
    .get();

  if (snapshot.empty) {
    return NextResponse.json({ data: [] });
  }

  const all: Finding[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Finding, 'id'>),
  }));

  const findings = nonHitsOnly
    ? all.filter((f) => f.isFalsePositive === true).slice(0, limit)
    : all.filter((f) => !f.isFalsePositive).slice(0, limit);

  return NextResponse.json({ data: findings });
}
