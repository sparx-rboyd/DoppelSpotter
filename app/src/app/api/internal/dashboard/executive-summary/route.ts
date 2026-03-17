import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse } from '@/lib/api-utils';
import { generateAndPersistDashboardExecutiveSummary } from '@/lib/dashboard-executive-summary';
import {
  getDashboardSummaryTasksServiceAccountEmail,
  isDashboardExecutiveSummaryTaskPayload,
} from '@/lib/dashboard-summary-tasks';
import { verifyGoogleOidcRequest } from '@/lib/internal-google-oidc';

export async function POST(request: NextRequest) {
  const authError = await verifyGoogleOidcRequest({
    request,
    expectedServiceAccountEmail: getDashboardSummaryTasksServiceAccountEmail(),
    logPrefix: '[dashboard-summary-tasks]',
    missingConfigMessage: 'Dashboard summary tasks are not configured',
  });
  if (authError) {
    return authError;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  if (!isDashboardExecutiveSummaryTaskPayload(body)) {
    return errorResponse('Invalid dashboard summary task payload');
  }

  const payload = body;
  const result = await generateAndPersistDashboardExecutiveSummary({
    brandId: payload.brandId,
    userId: payload.userId,
    force: payload.force === true,
  });

  return NextResponse.json({
    data: {
      result: result.outcome,
    },
  });
}
