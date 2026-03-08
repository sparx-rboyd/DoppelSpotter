import { type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth } from '@/lib/api-utils';
import type { FindingSummary } from '@/lib/types';

// GET /api/findings — latest findings across all of the authenticated user's brands
// Query params:
//   limit        (optional, default 20, max 100)
//   nonHitsOnly  (optional) — when "true", returns only AI-classified false-positives; otherwise returns only real findings
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const limitParam = request.nextUrl.searchParams.get('limit');
  const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100);
  const nonHitsOnly = request.nextUrl.searchParams.get('nonHitsOnly') === 'true';
  const query = db
    .collection('findings')
    .where('userId', '==', uid)
    .select(
      'scanId',
      'brandId',
      'source',
      'severity',
      'title',
      'theme',
      'llmAnalysis',
      'url',
      'isFalsePositive',
      'isIgnored',
      'isAddressed',
      'isBookmarked',
      'addressedAt',
      'bookmarkNote',
      'bookmarkedAt',
      'createdAt',
    )
    .orderBy('createdAt', 'desc');

  // Fetch the minimum number of pages needed to fill the requested limit,
  // rather than always overfetching by a fixed multiple and filtering in memory.
  const findings: FindingSummary[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  const pageSize = Math.min(Math.max(limit, 20), 100);

  while (findings.length < limit) {
    let pageQuery = query.limit(pageSize);
    if (cursor) {
      pageQuery = pageQuery.startAfter(cursor);
    }

    const snapshot = await pageQuery.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      const finding = {
        id: doc.id,
        ...(doc.data() as Omit<FindingSummary, 'id'>),
      } satisfies FindingSummary;

      const isMatch = nonHitsOnly
        ? finding.isFalsePositive === true
        : finding.isFalsePositive !== true && finding.isAddressed !== true;

      if (isMatch) {
        findings.push(finding);
        if (findings.length >= limit) break;
      }
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < pageSize) break;
  }

  return NextResponse.json({ data: findings });
}
