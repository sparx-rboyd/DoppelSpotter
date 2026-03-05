import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import type { BrandProfile, Scan, ScanSummary, ScanStatus } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

const TERMINAL_STATUSES: ScanStatus[] = ['completed', 'cancelled', 'failed'];

// GET /api/brands/[brandId]/scans
// Returns all terminal scans for the brand, newest first, with pre-computed severity counts.
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

  // Only include terminal scans in the result set list
  const terminalScans = allScans.filter((s) => TERMINAL_STATUSES.includes(s.status));

  if (terminalScans.length === 0) {
    return NextResponse.json({ data: [] });
  }

  // Fetch all findings for the brand (only the fields we need for counting)
  const findingsSnap = await db
    .collection('findings')
    .where('brandId', '==', brandId)
    .where('userId', '==', uid)
    .select('scanId', 'severity', 'isFalsePositive', 'isIgnored')
    .get();

  // Build per-scan count maps
  type Counts = { high: number; medium: number; low: number; nonHit: number; ignored: number };
  const countsByScanId = new Map<string, Counts>();

  for (const doc of findingsSnap.docs) {
    const { scanId, severity, isFalsePositive, isIgnored } = doc.data() as {
      scanId: string;
      severity: string;
      isFalsePositive?: boolean;
      isIgnored?: boolean;
    };
    if (!countsByScanId.has(scanId)) {
      countsByScanId.set(scanId, { high: 0, medium: 0, low: 0, nonHit: 0, ignored: 0 });
    }
    const counts = countsByScanId.get(scanId)!;
    // Check isFalsePositive first: false positives always count as nonHit even
    // when they are also auto-ignored. isIgnored only counts non-false-positive
    // findings that the user has manually dismissed.
    if (isFalsePositive) {
      counts.nonHit++;
    } else if (isIgnored) {
      counts.ignored++;
    } else if (severity === 'high') {
      counts.high++;
    } else if (severity === 'medium') {
      counts.medium++;
    } else if (severity === 'low') {
      counts.low++;
    }
  }

  const summaries: ScanSummary[] = terminalScans.map((scan) => {
    const counts = countsByScanId.get(scan.id) ?? { high: 0, medium: 0, low: 0, nonHit: 0, ignored: 0 };
    return {
      id: scan.id,
      status: scan.status,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      nonHitCount: counts.nonHit,
      ignoredCount: counts.ignored,
    };
  });

  return NextResponse.json({ data: summaries });
}
