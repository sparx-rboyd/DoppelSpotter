import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from 'firebase-admin/firestore';
import type { BrandProfile, Scan } from '@/lib/types';

// POST /api/scan — trigger a scan for a brand
// Body: { brandId: string; actorIds?: string[] }
export async function POST(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: { brandId: string; actorIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { brandId, actorIds } = body;
  if (!brandId) return errorResponse('brandId is required');

  // Verify brand ownership
  const brandDoc = await adminDb.collection('brands').doc(brandId).get();
  if (!brandDoc.exists) return errorResponse('Brand not found', 404);

  const brand = brandDoc.data() as BrandProfile;
  if (brand.userId !== uid) return errorResponse('Forbidden', 403);

  // Determine which actors to run — default to all core actors
  const { CORE_ACTOR_IDS } = await import('@/lib/apify/actors');
  const targetActorIds = actorIds ?? CORE_ACTOR_IDS;

  // Create a scan record
  const scanRef = adminDb.collection('scans').doc();
  const scan: Omit<Scan, 'id'> = {
    brandId,
    userId: uid,
    status: 'pending',
    actorIds: targetActorIds,
    findingCount: 0,
    startedAt: FieldValue.serverTimestamp() as unknown as import('firebase-admin/firestore').Timestamp,
  };

  await scanRef.set(scan);

  // TODO: Trigger the actual Apify pipeline here (async — use Apify webhooks to receive results)
  // For now, the scan record is created and the pipeline will be invoked in a follow-up task.
  // runApifyPipeline({ scanId: scanRef.id, brand, actorIds: targetActorIds });

  return NextResponse.json(
    { data: { scanId: scanRef.id, status: 'pending' } },
    { status: 202 },
  );
}

// GET /api/scan?scanId=xxx — poll scan status
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const scanId = request.nextUrl.searchParams.get('scanId');
  if (!scanId) return errorResponse('scanId query param is required');

  const scanDoc = await adminDb.collection('scans').doc(scanId).get();
  if (!scanDoc.exists) return errorResponse('Scan not found', 404);

  const scan = scanDoc.data() as Omit<Scan, 'id'>;
  if (scan.userId !== uid) return errorResponse('Forbidden', 403);

  return NextResponse.json({ data: { id: scanDoc.id, ...scan } });
}
