import { ApifyClient } from 'apify-client';
import type { BrandProfile } from '@/lib/types';
import { getDeepSearchGooglePageCount, getInitialGooglePageCount } from '@/lib/brands';
import { buildGoogleScannerQuery, sanitizeGoogleQueryForDisplay } from '@/lib/scan-sources';
import type { ActorConfig } from './actors';

let _client: ApifyClient | null = null;

function getClient(): ApifyClient {
  if (!_client) {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) throw new Error('APIFY_API_TOKEN is not set');
    _client = new ApifyClient({ token });
  }
  return _client;
}

export interface ActorRunResult {
  actorId: string;
  runId: string;
  datasetId: string;
  items: Record<string, unknown>[];
}

/**
 * Build the Google Search actor input payload for a brand profile.
 */
export function buildActorInput(
  actor: ActorConfig,
  brand: BrandProfile,
): { input: Record<string, unknown>; query: string; displayQuery: string } {
  const searchTerms = [brand.name, ...brand.keywords];
  const primaryQuery = searchTerms.join(' OR ');
  const query = buildGoogleScannerQuery(actor.source, primaryQuery);
  const googlePageCount = getInitialGooglePageCount(brand.searchResultPages);

  return {
    input: { queries: query, maxPagesPerQuery: googlePageCount },
    query,
    displayQuery: sanitizeGoogleQueryForDisplay(query),
  };
}

/**
 * Start a single Apify actor run asynchronously (non-blocking).
 * Attaches a webhook so Apify notifies the app when the run completes.
 * The webhook URL must be publicly reachable (use ngrok for local dev).
 */
export async function startActorRun(
  actor: ActorConfig,
  brand: BrandProfile,
  webhookUrl: string,
): Promise<{ runId: string; query: string; displayQuery: string }> {
  const client = getClient();
  const { input, query, displayQuery } = buildActorInput(actor, brand);

  const run = await client.actor(actor.actorId).start(input, {
    webhooks: [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
        requestUrl: webhookUrl,
        headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
      },
    ],
  });

  return { runId: run.id, query, displayQuery };
}

/**
 * Start a Google Search actor run for a specific deep-search query.
 * Used by the webhook handler when AI analysis requests follow-up searches.
 * The actor input mirrors the core scan input but uses a custom query string.
 */
export async function startDeepSearchRun(
  params: {
    actor: ActorConfig;
    query: string;
    searchResultPages: number | undefined;
    webhookUrl: string;
  },
): Promise<{ runId: string; query: string; displayQuery: string }> {
  const { actor, query, searchResultPages, webhookUrl } = params;
  const client = getClient();
  const executableQuery = buildGoogleScannerQuery(actor.source, query);
  const deepSearchPageCount = getDeepSearchGooglePageCount(searchResultPages);

  const run = await client.actor(actor.actorId).start(
    { queries: executableQuery, maxPagesPerQuery: deepSearchPageCount },
    {
      webhooks: [
        {
          eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
          requestUrl: webhookUrl,
          headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
        },
      ],
    },
  );

  return {
    runId: run.id,
    query: executableQuery,
    displayQuery: sanitizeGoogleQueryForDisplay(executableQuery),
  };
}

/**
 * Abort an in-flight Apify actor run.
 * Resolves silently if the run has already finished (Apify ignores the call).
 */
export async function abortActorRun(runId: string): Promise<void> {
  const client = getClient();
  await client.run(runId).abort();
}

/**
 * Fetch all items from an Apify dataset.
 * Used by the webhook handler after an actor run succeeds.
 */
export async function fetchDatasetItems(datasetId: string): Promise<Record<string, unknown>[]> {
  const client = getClient();
  const { items } = await client.dataset(datasetId).listItems();
  return items as Record<string, unknown>[];
}

/**
 * Run a single Apify actor synchronously and return its dataset items.
 * Kept for testing/CLI use — the pipeline uses startActorRun() + webhooks instead.
 */
export async function runActor(
  actor: ActorConfig,
  brand: BrandProfile,
  webhookUrl?: string,
): Promise<ActorRunResult> {
  const client = getClient();
  const { input } = buildActorInput(actor, brand);

  const runOptions: Record<string, unknown> = { input };

  if (webhookUrl) {
    runOptions.webhooks = [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
        requestUrl: webhookUrl,
        headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
      },
    ];
  }

  const run = await client.actor(actor.actorId).call(input, runOptions);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  return {
    actorId: actor.actorId,
    runId: run.id,
    datasetId: run.defaultDatasetId,
    items: items as Record<string, unknown>[],
  };
}
