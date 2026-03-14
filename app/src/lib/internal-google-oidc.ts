import { OAuth2Client } from 'google-auth-library';
import { type NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api-utils';
import { buildAppUrl } from '@/lib/scan-runner';

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

export async function verifyGoogleOidcRequest(params: {
  request: NextRequest;
  expectedServiceAccountEmail?: string | null;
  logPrefix: string;
  missingConfigMessage: string;
}): Promise<NextResponse | null> {
  const { request, expectedServiceAccountEmail, logPrefix, missingConfigMessage } = params;
  if (!expectedServiceAccountEmail) {
    console.error(`${logPrefix} Missing expected service account email`);
    return errorResponse(missingConfigMessage, 500);
  }

  const normalizedExpectedEmail = expectedServiceAccountEmail.trim().toLowerCase();
  const publicAppUrl = buildAppUrl(request.headers);
  const routeAudience = `${publicAppUrl}${request.nextUrl.pathname}`;
  const acceptableAudiences = new Set([
    routeAudience,
    routeAudience.replace(/\/$/, ''),
    publicAppUrl,
    publicAppUrl.replace(/\/$/, ''),
  ].map(normalizeAudience));

  const oidcToken = extractBearerToken(request);
  if (!oidcToken) {
    console.error(`${logPrefix} Missing bearer token`, {
      hasAuthorizationHeader: request.headers.has('authorization'),
      hasServerlessAuthorizationHeader: request.headers.has('x-serverless-authorization'),
      expectedEmail: expectedServiceAccountEmail,
      expectedAudience: routeAudience,
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
    const matchesConfiguredEmail = tokenEmail === normalizedExpectedEmail;
    const hasAcceptableAudience = payloadAudiences
      .map((audience) => normalizeAudience(audience))
      .some((audience) => acceptableAudiences.has(audience));

    if (!payload || !matchesConfiguredEmail || !hasValidIssuer || !hasAcceptableAudience) {
      console.error(`${logPrefix} Rejected Google OIDC token payload`, {
        email: payload?.email ?? null,
        sub: payload?.sub ?? null,
        iss: payload?.iss ?? null,
        aud: payload?.aud ?? null,
        normalizedAudiences: payloadAudiences.map((audience) => normalizeAudience(audience)),
        expectedEmail: expectedServiceAccountEmail,
        expectedAudiences: Array.from(acceptableAudiences),
      });
      return errorResponse('Unauthorized', 401);
    }
  } catch (error) {
    console.error(`${logPrefix} Failed to verify Google OIDC token:`, error);
    return errorResponse('Unauthorized', 401);
  }

  return null;
}
