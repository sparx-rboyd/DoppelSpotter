import { NextResponse, type NextRequest } from 'next/server';
import {
  drainAccountDeletion,
  drainBrandDeletion,
  drainBrandHistoryDeletion,
  drainScanDeletion,
} from '@/lib/async-deletions';
import {
  DELETION_TASK_WORKER_BUDGET_MS,
  enqueueDeletionFollowUpTask,
  getDeletionTasksServiceAccountEmail,
  isDeletionTaskPayload,
} from '@/lib/deletion-tasks';
import { errorResponse } from '@/lib/api-utils';
import { verifyGoogleOidcRequest } from '@/lib/internal-google-oidc';

export async function POST(request: NextRequest) {
  const authError = await verifyGoogleOidcRequest({
    request,
    expectedServiceAccountEmail: getDeletionTasksServiceAccountEmail(),
    logPrefix: '[deletion-tasks]',
    missingConfigMessage: 'Deletion tasks are not configured',
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

  if (!isDeletionTaskPayload(body)) {
    return errorResponse('Invalid deletion task payload');
  }

  const payload = body;
  const result = payload.kind === 'account'
    ? await drainAccountDeletion({
        userId: payload.userId,
        budgetMs: DELETION_TASK_WORKER_BUDGET_MS,
      })
    : payload.kind === 'scan'
      ? await drainScanDeletion({
        brandId: payload.brandId,
        scanId: payload.scanId,
        userId: payload.userId,
        budgetMs: DELETION_TASK_WORKER_BUDGET_MS,
      })
      : payload.kind === 'brand-history'
        ? await drainBrandHistoryDeletion({
          brandId: payload.brandId,
          userId: payload.userId,
          budgetMs: DELETION_TASK_WORKER_BUDGET_MS,
        })
        : await drainBrandDeletion({
          brandId: payload.brandId,
          userId: payload.userId,
          budgetMs: DELETION_TASK_WORKER_BUDGET_MS,
        });

  if (result === 'progress') {
    await enqueueDeletionFollowUpTask({
      payload,
      requestHeaders: request.headers,
    });
  }

  return NextResponse.json({
    data: {
      result,
    },
  });
}
