import { after, NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { verifyGoogleOidcRequest } from '@/lib/internal-google-oidc';
import { buildAppUrl, kickoffReservedScan, ScanStartError, startScanForBrand } from '@/lib/scan-runner';

const MAX_DUE_BRANDS_PER_DISPATCH = 20;

export async function POST(request: NextRequest) {
  const schedulerServiceAccountEmail = process.env.SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL;
  const authError = await verifyGoogleOidcRequest({
    request,
    expectedServiceAccountEmail: schedulerServiceAccountEmail,
    logPrefix: '[scheduled-scans]',
    missingConfigMessage: 'Scheduler is not configured',
  });
  if (authError) {
    return authError;
  }

  const dispatchedAt = new Date();
  const dueBrandsSnapshot = await db
    .collection('brands')
    .where('scanSchedule.enabled', '==', true)
    .where('scanSchedule.nextRunAt', '<=', dispatchedAt)
    .orderBy('scanSchedule.nextRunAt', 'asc')
    .limit(MAX_DUE_BRANDS_PER_DISPATCH)
    .get();

  const summary = {
    processed: dueBrandsSnapshot.size,
    started: 0,
    skippedActiveScan: 0,
    skippedNotDue: 0,
    failed: 0,
    hasMoreDueBrands: dueBrandsSnapshot.size === MAX_DUE_BRANDS_PER_DISPATCH,
  };
  const webhookUrl = `${buildAppUrl(request.headers)}/api/webhooks/apify`;

  for (const brandDoc of dueBrandsSnapshot.docs) {
    try {
      const result = await startScanForBrand({
        brandId: brandDoc.id,
        scheduled: { dispatchedAt },
      });

      if (result.outcome === 'started') {
        after(async () => {
          try {
            await kickoffReservedScan({
              scanId: result.scanId,
              webhookUrl,
            });
          } catch (error) {
            console.error(`[scheduled-scans] Background kickoff failed for brand ${brandDoc.id}:`, error);
          }
        });
        summary.started++;
        continue;
      }

      if (result.reason === 'active_scan') {
        summary.skippedActiveScan++;
      } else {
        summary.skippedNotDue++;
      }
    } catch (error) {
      summary.failed++;

      if (error instanceof ScanStartError) {
        console.error(`[scheduled-scans] Failed to start scan for brand ${brandDoc.id}: ${error.message}`);
      } else {
        console.error(`[scheduled-scans] Unexpected failure for brand ${brandDoc.id}:`, error);
      }
    }
  }

  return NextResponse.json({ data: summary });
}
