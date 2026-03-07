import { NextResponse, type NextRequest } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import { db } from '@/lib/firestore';
import { errorResponse } from '@/lib/api-utils';
import { ScanStartError, startScanForBrand } from '@/lib/scan-runner';

const MAX_DUE_BRANDS_PER_DISPATCH = 20;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const oidcClient = new OAuth2Client();

function normalizeAudience(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function extractBearerToken(request: NextRequest): string | null {
  const candidateHeaders = [
    request.headers.get('authorization'),
    request.headers.get('x-serverless-authorization'),
  ];

  for (const headerValue of candidateHeaders) {
    if (!headerValue?.startsWith('Bearer ')) continue;
    const token = headerValue.slice('Bearer '.length).trim();
    if (token) return token;
  }

  return null;
}

export async function POST(request: NextRequest) {
  const schedulerServiceAccountEmail = process.env.SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL;
  if (!schedulerServiceAccountEmail) {
    console.error('[scheduled-scans] Missing SCHEDULE_DISPATCH_SERVICE_ACCOUNT_EMAIL');
    return errorResponse('Scheduler is not configured', 500);
  }
  const normalizedSchedulerServiceAccountEmail = schedulerServiceAccountEmail.trim().toLowerCase();

  const dispatcherAudience = `${request.nextUrl.origin}${request.nextUrl.pathname}`;
  const acceptableAudiences = new Set([
    dispatcherAudience,
    dispatcherAudience.replace(/\/$/, ''),
    request.nextUrl.origin,
    request.nextUrl.origin.replace(/\/$/, ''),
  ].map(normalizeAudience));
  const oidcToken = extractBearerToken(request);
  if (!oidcToken) {
    console.error('[scheduled-scans] Missing bearer token on scheduler request', {
      hasAuthorizationHeader: request.headers.has('authorization'),
      hasServerlessAuthorizationHeader: request.headers.has('x-serverless-authorization'),
      expectedEmail: schedulerServiceAccountEmail,
      expectedAudience: dispatcherAudience,
    });
    return errorResponse('Unauthorized', 401);
  }

  try {
    const ticket = await oidcClient.verifyIdToken({ idToken: oidcToken });
    const payload = ticket.getPayload();
    const payloadAudiences = Array.isArray(payload?.aud)
      ? payload.aud
      : payload?.aud
        ? [payload.aud]
        : [];
    const tokenEmail = payload?.email?.trim().toLowerCase();
    const hasValidIssuer = GOOGLE_ISSUERS.has(payload?.iss ?? '');
    const matchesConfiguredEmail = tokenEmail === normalizedSchedulerServiceAccountEmail;
    const hasAcceptableAudience = payloadAudiences
      .map((audience) => normalizeAudience(audience))
      .some((audience) => acceptableAudiences.has(audience));

    if (
      !payload ||
      !matchesConfiguredEmail ||
      !hasValidIssuer ||
      !hasAcceptableAudience
    ) {
      console.error('[scheduled-scans] Rejected Cloud Scheduler token payload', {
        email: payload?.email ?? null,
        sub: payload?.sub ?? null,
        iss: payload?.iss ?? null,
        aud: payload?.aud ?? null,
        normalizedAudiences: payloadAudiences.map((audience) => normalizeAudience(audience)),
        expectedEmail: schedulerServiceAccountEmail,
        expectedAudiences: Array.from(acceptableAudiences),
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
