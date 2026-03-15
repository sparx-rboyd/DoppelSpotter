import { CloudTasksClient } from '@google-cloud/tasks';
import { buildAppUrl } from '@/lib/scan-runner';

export const DASHBOARD_SUMMARY_TASKS_ROUTE_PATH = '/api/internal/dashboard/executive-summary';
const cloudTasksClient = new CloudTasksClient();

export type DashboardExecutiveSummaryTaskPayload = {
  kind: 'dashboard-executive-summary';
  brandId: string;
  userId: string;
  force?: boolean;
};

function getDashboardSummaryTasksConfig() {
  const queuePath = process.env.DASHBOARD_SUMMARY_TASKS_QUEUE_PATH?.trim();
  const serviceAccountEmail = process.env.DASHBOARD_SUMMARY_TASKS_SERVICE_ACCOUNT_EMAIL?.trim();

  if (!queuePath || !serviceAccountEmail) {
    return null;
  }

  return {
    queuePath,
    serviceAccountEmail,
  };
}

export function getDashboardSummaryTasksServiceAccountEmail(): string | null {
  return process.env.DASHBOARD_SUMMARY_TASKS_SERVICE_ACCOUNT_EMAIL?.trim() ?? null;
}

export function isDashboardExecutiveSummaryTaskPayload(value: unknown): value is DashboardExecutiveSummaryTaskPayload {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<DashboardExecutiveSummaryTaskPayload>;
  return candidate.kind === 'dashboard-executive-summary'
    && typeof candidate.brandId === 'string'
    && typeof candidate.userId === 'string'
    && (candidate.force === undefined || typeof candidate.force === 'boolean');
}

export async function enqueueDashboardExecutiveSummaryTask(params: {
  payload: DashboardExecutiveSummaryTaskPayload;
  requestHeaders: Headers;
}): Promise<'enqueued' | 'disabled'> {
  const { payload, requestHeaders } = params;
  const config = getDashboardSummaryTasksConfig();
  if (!config) {
    return 'disabled';
  }

  const workerUrl = `${buildAppUrl(requestHeaders)}${DASHBOARD_SUMMARY_TASKS_ROUTE_PATH}`;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');

  await cloudTasksClient.createTask({
    parent: config.queuePath,
    task: {
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

export async function scheduleDashboardExecutiveSummaryTaskOrRunInline(params: {
  payload: DashboardExecutiveSummaryTaskPayload;
  requestHeaders: Headers;
  logPrefix: string;
  runInline: () => Promise<unknown>;
}) {
  const { payload, requestHeaders, logPrefix, runInline } = params;

  try {
    const enqueueResult = await enqueueDashboardExecutiveSummaryTask({
      payload,
      requestHeaders,
    });

    if (enqueueResult === 'disabled') {
      await runInline();
    }
  } catch (error) {
    console.error(`${logPrefix} Failed to enqueue Cloud Task; falling back to inline execution:`, error);
    await runInline();
  }
}
