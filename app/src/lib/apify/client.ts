import { ApifyClient } from 'apify-client';
import type { BrandProfile } from '@/lib/types';
import {
  getInitialDiscordMaxTotalChargeUsd,
  getDeepSearchGooglePageCount,
  getInitialGitHubMaxResults,
  getInitialGooglePageCount,
  getInitialXMaxItems,
} from '@/lib/brands';
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
 * Build a source-specific actor input payload for a brand profile.
 */
export function buildActorInput(
  actor: ActorConfig,
  brand: BrandProfile,
): { input: Record<string, unknown>; query: string; displayQuery: string } {
  const searchTerms = normalizeSearchTerms([brand.name, ...brand.keywords]);

  if (actor.kind === 'discord') {
    const query = joinSearchTermsForDisplay(searchTerms);
    return {
      input: { keywords: searchTerms },
      query,
      displayQuery: query,
    };
  }

  if (actor.kind === 'x') {
    const query = joinSearchTermsForDisplay(searchTerms);
    return {
      input: {
        searchTerms,
        maxItems: getInitialXMaxItems(brand.searchResultPages),
        sort: 'Latest',
        includeSearchTerms: true,
      },
      query,
      displayQuery: query,
    };
  }

  if (actor.kind === 'github') {
    const displayQuery = joinSearchTermsForDisplay(searchTerms);
    const query = buildGitHubRepoSearchQuery(searchTerms);
    return {
      input: {
        query,
        sortBy: 'best-match',
        maxResults: getInitialGitHubMaxResults(brand.searchResultPages),
      },
      query,
      displayQuery,
    };
  }

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
  const startOptions: Record<string, unknown> = {
    webhooks: [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
        requestUrl: webhookUrl,
        headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
      },
    ],
  };

  if (actor.kind === 'discord') {
    startOptions.maxTotalChargeUsd = getInitialDiscordMaxTotalChargeUsd(brand.searchResultPages);
  }

  const run = await client.actor(actor.actorId).start(input, startOptions);

  return { runId: run.id, query, displayQuery };
}

/**
 * Start a deep-search actor run for a supported custom follow-up query.
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

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error('Deep-search query must not be empty');
  }

  if (!actor.supportsDeepSearch) {
    throw new Error(`Deep search is not supported for ${actor.displayName}`);
  }

  let runInput: Record<string, unknown>;
  let executableQuery: string;
  let displayQuery: string;
  const startOptions: Record<string, unknown> = {
    webhooks: [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED'],
        requestUrl: webhookUrl,
        headersTemplate: `{"X-Apify-Webhook-Secret": "${process.env.APIFY_WEBHOOK_SECRET}"}`,
      },
    ],
  };

  if (actor.kind === 'google') {
    executableQuery = buildGoogleScannerQuery(actor.source, trimmedQuery);
    runInput = {
      queries: executableQuery,
      maxPagesPerQuery: getDeepSearchGooglePageCount(searchResultPages),
    };
    displayQuery = sanitizeGoogleQueryForDisplay(executableQuery);
  } else {
    throw new Error(`Deep search is not implemented for ${actor.displayName}`);
  }

  const run = await client.actor(actor.actorId).start(runInput, startOptions);

  return {
    runId: run.id,
    query: executableQuery,
    displayQuery,
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
  if (actor.kind === 'discord') {
    runOptions.maxTotalChargeUsd = getInitialDiscordMaxTotalChargeUsd(brand.searchResultPages);
  }

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

function normalizeSearchTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function joinSearchTermsForDisplay(values: string[]): string {
  return values.join(' | ');
}

function buildGitHubRepoSearchQuery(values: string[]): string {
  return values
    .map((value) => `"${value.replace(/"/g, '\\"')}"`)
    .join(' OR ');
}
