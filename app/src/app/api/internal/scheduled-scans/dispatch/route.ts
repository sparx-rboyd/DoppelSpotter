import { NextResponse, type NextRequest } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import { db } from '@/lib/firestore';
import { errorResponse } from '@/lib/api-utils';
import { ScanStartError, startScanForBrand } from '@/lib/scan-runner';

const MAX_DUE_BRANDS_PER_DISPATCH = 20;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const oidcClient = new OAuth2Client();

export async function POST(request: NextRequest) {
  const schedulerServiceAccountEmail = process.env.SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL;
  if (!schedulerServiceAccountEmail) {
    console.error('[scheduled-scans] Missing SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL');
    return errorResponse('Scheduler is not configured', 500);
  }
  const normalizedSchedulerServiceAccountEmail = schedulerServiceAccountEmail.trim().toLowerCase();

  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return errorResponse('Unauthorized', 401);
  }

  const dispatcherAudience = `${request.nextUrl.origin}${request.nextUrl.pathname}`;
  const oidcToken = authorizationHeader.slice('Bearer '.length).trim();

  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: oidcToken,
      audience: dispatcherAudience,
    });
    const payload = ticket.getPayload();
    const tokenEmail = payload?.email?.trim().toLowerCase();
    const hasValidIssuer = GOOGLE_ISSUERS.has(payload?.iss ?? '');
    const matchesConfiguredEmail = tokenEmail === normalizedSchedulerServiceAccountEmail;

    if (
      !payload ||
      !matchesConfiguredEmail ||
      !hasValidIssuer
    ) {
      console.error('[scheduled-scans] Rejected Cloud Scheduler token payload', {
        email: payload?.email ?? null,
        sub: payload?.sub ?? null,
        iss: payload?.iss ?? null,
        aud: payload?.aud ?? null,
        expectedEmail: schedulerServiceAccountEmail,
        expectedAudience: dispatcherAudience,
      });
      return errorResponse('Unauthorized', 401);
    }
  } catch (error) {
    console.error('[scheduled-scans] Failed to verify Cloud Scheduler OIDC token:', error);
    return errorResponse('Unauthorized', 401);
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

  for (const brandDoc of dueBrandsSnapshot.docs) {
    try {
      const result = await startScanForBrand({
        brandId: brandDoc.id,
        requestHeaders: request.headers,
        scheduled: { dispatchedAt },
      });

      if (result.outcome === 'started') {
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
