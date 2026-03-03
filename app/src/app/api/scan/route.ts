import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from 'firebase-admin/firestore';
import type { BrandProfile, Scan, ActorRunInfo } from '@/lib/types';

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
  const { CORE_ACTOR_IDS, getActorConfig } = await import('@/lib/apify/actors');
  const { startActorRun } = await import('@/lib/apify/client');

  const targetActorIds = actorIds ?? CORE_ACTOR_IDS;

  // Create a scan record with status 'pending' first so we have a scanId
  const scanRef = adminDb.collection('scans').doc();
  const scan: Omit<Scan, 'id'> = {
    brandId,
    userId: uid,
    status: 'pending',
    actorIds: targetActorIds,
    actorRunIds: [],
    actorRuns: {},
    completedRunCount: 0,
    findingCount: 0,
    startedAt: FieldValue.serverTimestamp() as unknown as import('firebase-admin/firestore').Timestamp,
  };

  await scanRef.set(scan);

  // Build the webhook URL — must be publicly reachable (use APP_URL env var)
  const appUrl = buildAppUrl(request);
  const webhookUrl = `${appUrl}/api/webhooks/apify`;

  // Start each actor asynchronously; collect run IDs as they start
  const actorRunIds: string[] = [];
  const actorRuns: Record<string, ActorRunInfo> = {};
  let successCount = 0;

  for (const actorId of targetActorIds) {
    const actorConfig = getActorConfig(actorId);
    if (!actorConfig) {
      console.warn(`[scan] Unknown actor ID: ${actorId} — skipping`);
      continue;
    }

    try {
      const { runId } = await startActorRun(actorConfig, brand, webhookUrl);
      actorRunIds.push(runId);
      actorRuns[runId] = {
        actorId,
        source: actorConfig.source,
        status: 'running',
      };
      successCount++;
      console.log(`[scan] Started actor ${actorId} → runId=${runId}`);
    } catch (err) {
      console.error(`[scan] Failed to start actor ${actorId}:`, err);
    }
  }

  // If every actor failed to start, mark the scan as failed immediately
  if (successCount === 0) {
    await scanRef.update({
      status: 'failed',
      errorMessage: 'All actor runs failed to start',
      completedAt: FieldValue.serverTimestamp(),
    });
    return errorResponse('Failed to start any actor runs', 500);
  }

  // Update scan with run IDs and set status to 'running'
  await scanRef.update({
    status: 'running',
    actorRunIds,
    actorRuns,
    // If some actors failed to start, pre-count them as completed so the
    // webhook handler can still detect overall scan completion correctly.
    completedRunCount: targetActorIds.length - successCount,
  });

  return NextResponse.json(
    { data: { scanId: scanRef.id, status: 'running', actorCount: successCount } },
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

/**
 * Derive the app's public base URL for webhook callbacks.
 * Priority: APP_URL env var → x-forwarded-proto + x-forwarded-host headers → host header (http).
 */
function buildAppUrl(request: NextRequest): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, '');
  }

  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}
