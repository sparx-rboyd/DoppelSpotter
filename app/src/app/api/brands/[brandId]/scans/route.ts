import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, Scan, ScanSummary, ScanStatus } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

const TERMINAL_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];

// GET /api/brands/[brandId]/scans
// Returns all terminal scans for the brand, newest first, using denormalized counts stored
// on each scan document (written by the webhook, updated on ignore/un-ignore).
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;

  // Verify brand ownership
  const brandDoc = await db.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);
  if ((brandDoc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  // Fetch all terminal scans for the brand, newest first
  const scansSnap = await db
    .collection('scans')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .orderBy('startedAt', 'desc')
    .limit(50)
    .get();

  const allScans = scansSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<Scan, 'id'>),
  }));

  const terminalScans = allScans.filter((s) => TERMINAL_STATUSES.includes(s.status));

  // Use denormalized counts stored on each scan document. The `?? 0` fallback
  // handles scans created before the backfill script ran.
  const summaries: ScanSummary[] = terminalScans.map((scan) => ({
    id: scan.id,
    status: scan.status,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    highCount: scan.highCount ?? 0,
    mediumCount: scan.mediumCount ?? 0,
    lowCount: scan.lowCount ?? 0,
    nonHitCount: scan.nonHitCount ?? 0,
    ignoredCount: scan.ignoredCount ?? 0,
  }));

  return NextResponse.json({ data: summaries });
}
