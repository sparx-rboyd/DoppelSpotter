import { ApifyClient } from 'apify-client';
import type { BrandProfile } from '@/lib/types';
import { getDeepSearchGooglePageCount, getGoogleResultsPageCount } from '@/lib/brands';
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
 * Build the actor input payload for a given actor and brand profile.
 * Each actor expects a different input shape — map brand profile fields accordingly.
 * Exported so the scan route can inspect inputs during start-up logging.
 */
export function buildActorInput(actorId: string, brand: BrandProfile): Record<string, unknown> {
  const searchTerms = [brand.name, ...brand.keywords];
  const primaryQuery = searchTerms.join(' OR ');
  const googlePageCount = getGoogleResultsPageCount(brand.googleResultsLimit);

  // Actor-specific input mappings
  switch (actorId) {
    case 'apify/google-search-scraper':
      return { queries: primaryQuery, maxPagesPerQuery: googlePageCount };

    case 'apify/instagram-search-scraper':
      return { searchQueries: searchTerms, maxResults: 20 };

    case 'data-slayer/twitter-search':
      return { searchTerms: searchTerms, maxTweets: 50 };

    case 'apify/facebook-search-scraper':
      return { queries: searchTerms, maxResults: 20 };

    case 'apilab/google-play-scraper':
      return { searchQuery: brand.name, country: 'us', limit: 20 };

    case 'dan.scraper/apple-app-store-search-scraper':
      return { queries: [brand.name], country: 'us', limit: 20 };

    case 'doppelspotter/whoisxml-brand-alert':
      return {
        brandKeywords: searchTerms,
        apiKey: process.env.WHOISXML_API_KEY,
        lookbackDays: 1,
      };

    case 'ryanclinton/euipo-trademark-search':
      return { searchTerm: brand.name, maxResults: 50 };

    default:
      return { query: primaryQuery };
  }
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
): Promise<{ runId: string }> {
  const client = getClient();
  const input = buildActorInput(actor.actorId, brand);

  const run = await client.actor(actor.actorId).start(input, {
    webhooks: [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
        requestUrl: webhookUrl,
        headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
      },
    ],
  });

  return { runId: run.id };
}

/**
 * Start a Google Search actor run for a specific deep-search query.
 * Used by the webhook handler when AI analysis requests follow-up searches.
 * The actor input mirrors the core scan input but uses a custom query string.
 */
export async function startDeepSearchRun(
  query: string,
  webhookUrl: string,
  googleResultsLimit?: number,
): Promise<{ runId: string }> {
  const client = getClient();
  const deepSearchPageCount = getDeepSearchGooglePageCount(googleResultsLimit);

  const run = await client.actor('apify/google-search-scraper').start(
    { queries: query, maxPagesPerQuery: deepSearchPageCount },
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

  return { runId: run.id };
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
  const input = buildActorInput(actor.actorId, brand);

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
