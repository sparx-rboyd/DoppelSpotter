import { CloudTasksClient } from '@google-cloud/tasks';
import { buildAppUrl } from '@/lib/scan-runner';

export const DELETION_TASKS_ROUTE_PATH = '/api/internal/deletions/drain';
export const DELETION_TASK_WORKER_BUDGET_MS = 25_000;
const DELETION_TASK_PROGRESS_DELAY_SECONDS = 1;

const cloudTasksClient = new CloudTasksClient();

export type DeletionTaskPayload =
  | {
      kind: 'scan';
      brandId: string;
      scanId: string;
      userId: string;
    }
  | {
      kind: 'brand-history' | 'brand';
      brandId: string;
      userId: string;
    };

function getDeletionTasksConfig() {
  const queuePath = process.env.DELETION_TASKS_QUEUE_PATH?.trim();
  const serviceAccountEmail = process.env.DELETION_TASKS_SERVICE_ACCOUNT_EMAIL?.trim();

  if (!queuePath || !serviceAccountEmail) {
    return null;
  }

  return {
    queuePath,
    serviceAccountEmail,
  };
}

export function getDeletionTasksServiceAccountEmail(): string | null {
  return process.env.DELETION_TASKS_SERVICE_ACCOUNT_EMAIL?.trim() ?? null;
}

export function isDeletionTaskPayload(value: unknown): value is DeletionTaskPayload {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<DeletionTaskPayload>;
  if (typeof candidate.brandId !== 'string' || typeof candidate.userId !== 'string') {
    return false;
  }

  if (candidate.kind === 'scan') {
    return typeof candidate.scanId === 'string';
  }

  return candidate.kind === 'brand' || candidate.kind === 'brand-history';
}

export async function enqueueDeletionTask(params: {
  payload: DeletionTaskPayload;
  requestHeaders: Headers;
  delaySeconds?: number;
}): Promise<'enqueued' | 'disabled'> {
  const { payload, requestHeaders, delaySeconds = 0 } = params;
  const config = getDeletionTasksConfig();
  if (!config) {
    return 'disabled';
  }

  const workerUrl = `${buildAppUrl(requestHeaders)}${DELETION_TASKS_ROUTE_PATH}`;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');

  await cloudTasksClient.createTask({
    parent: config.queuePath,
    task: {
      ...(delaySeconds > 0
        ? {
            scheduleTime: {
              seconds: Math.floor(Date.now() / 1000) + delaySeconds,
            },
          }
        : {}),
      httpRequest: {
        httpMethod: 'POST',
        url: workerUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        oidcToken: {
          serviceAccountEmail: config.serviceAccountEmail,
          audience: workerUrl,
        },
      },
    },
  });

  return 'enqueued';
}

export async function enqueueDeletionFollowUpTask(params: {
  payload: DeletionTaskPayload;
  requestHeaders: Headers;
}) {
  return enqueueDeletionTask({
    ...params,
    delaySeconds: DELETION_TASK_PROGRESS_DELAY_SECONDS,
  });
}

export async function scheduleDeletionTaskOrRunInline(params: {
  payload: DeletionTaskPayload;
  requestHeaders: Headers;
  logPrefix: string;
  runInline: () => Promise<unknown>;
}) {
  const { payload, requestHeaders, logPrefix, runInline } = params;

  try {
    const enqueueResult = await enqueueDeletionTask({
      payload,
      requestHeaders,
    });

    if (enqueueResult === 'disabled') {
      await runInline();
    }
  } catch (error) {
    console.error(`${logPrefix} Failed to enqueue Cloud Task; falling back to inline drain:`, error);
    await runInline();
  }
}
