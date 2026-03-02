import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { Scan } from '@/lib/types';

/**
 * POST /api/webhooks/apify
 *
 * Receives Apify webhook callbacks when an actor run completes.
 * Apify sends a POST to this URL with a JSON body containing run metadata.
 *
 * The webhook URL is configured per-run when triggering actors via the Apify API.
 * A shared secret is validated via the X-Apify-Webhook-Secret header.
 *
 * Reference: https://docs.apify.com/platform/integrations/webhooks
 */
export async function POST(request: NextRequest) {
  // Validate shared secret
  const secret = request.headers.get('X-Apify-Webhook-Secret');
  if (secret !== process.env.APIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let payload: {
    eventType: string;
    eventData: {
      actorId: string;
      actorRunId: string;
      status: string;
    };
    resource: {
      id: string;
      status: string;
      defaultDatasetId: string;
    };
  };

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { resource } = payload;

  if (!resource?.id) {
    return NextResponse.json({ error: 'Missing resource.id' }, { status: 400 });
  }

  // Look up the scan associated with this actor run
  // Convention: we store actorRunId on the scan document when triggering
  const snapshot = await adminDb
    .collection('scans')
    .where('apifyRunId', '==', resource.id)
    .limit(1)
    .get();

  if (snapshot.empty) {
    // Unknown run — acknowledge but take no action
    return NextResponse.json({ received: true });
  }

  const scanDoc = snapshot.docs[0];
  const scan = scanDoc.data() as Scan;

  if (resource.status === 'SUCCEEDED') {
    // TODO: Fetch dataset items, run LLM analysis, write findings to Firestore
    // analyseScanResults({ scanId: scanDoc.id, brand, datasetId: resource.defaultDatasetId });

    await scanDoc.ref.update({
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
    });
  } else if (resource.status === 'FAILED' || resource.status === 'ABORTED') {
    await scanDoc.ref.update({
      status: 'failed',
      errorMessage: `Actor run ${resource.id} ended with status: ${resource.status}`,
      completedAt: FieldValue.serverTimestamp(),
    });
  }

  // Suppress TS unused variable warning on scan
  void scan;

  return NextResponse.json({ received: true });
}
