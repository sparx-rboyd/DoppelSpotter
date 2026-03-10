import { ApifyClient } from 'apify-client';
import type { BrandProfile, EffectiveScanSettings } from '@/lib/types';
import {
  getInitialDomainRegistrationLimit,
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

export interface ActorRunStart {
  runId: string;
  query: string;
  displayQuery: string;
}

export interface StartActorRunsResult {
  runs: ActorRunStart[];
  failedCount: number;
}

type PreparedActorInput = {
  input: Record<string, unknown>;
  query: string;
  displayQuery: string;
};

type ActorRunBrandContext = Pick<BrandProfile, 'name' | 'keywords'>;

const GITHUB_MIN_RESULTS_PER_KEYWORD = 10;

/**
 * Build a source-specific actor input payload for a brand profile.
 */
export function buildActorInput(
  actor: ActorConfig,
  brand: ActorRunBrandContext,
  settings: EffectiveScanSettings,
): { input: Record<string, unknown>; query: string; displayQuery: string } {
  const actorInputs = buildActorInputs(actor, brand, settings);
  if (actorInputs.length !== 1) {
    throw new Error(`buildActorInput does not support batched inputs for ${actor.id}; use buildActorInputs instead`);
  }
  return actorInputs[0];
}

function buildActorInputs(
  actor: ActorConfig,
  brand: ActorRunBrandContext,
  settings: EffectiveScanSettings,
): PreparedActorInput[] {
  const searchTerms = normalizeSearchTerms([brand.name, ...brand.keywords]);

  if (actor.kind === 'domains') {
    return [{
      input: {
        apiKey: getRequiredEnvVar('CODEPUNCH_API_KEY'),
        apiSecret: getRequiredEnvVar('CODEPUNCH_API_SECRET'),
        date: settings.lookbackDate,
        dateComparison: 'gte',
        keywords: searchTerms,
        enhancedAnalysisEnabled: true,
        openRouterApiKey: getRequiredEnvVar('OPENROUTER_API_KEY'),
        totalLimit: getInitialDomainRegistrationLimit(settings.searchResultPages),
      },
      query: joinSearchTermsForDisplay(searchTerms),
      displayQuery: joinSearchTermsForDisplay(searchTerms),
    }];
  }

  if (actor.kind === 'discord') {
    const query = joinSearchTermsForDisplay(searchTerms);
    return [{
      input: { keywords: searchTerms },
      query,
      displayQuery: query,
    }];
  }

  if (actor.kind === 'x') {
    const query = joinSearchTermsForDisplay(searchTerms);
    return [{
      input: {
        searchTerms,
        maxItems: getInitialXMaxItems(settings.searchResultPages),
        sort: 'Latest',
        includeSearchTerms: true,
        tweetDateSince: settings.lookbackDate,
      },
      query,
      displayQuery: query,
    }];
  }

  if (actor.kind === 'github') {
    const maxResultsPerTerm = Math.max(
      GITHUB_MIN_RESULTS_PER_KEYWORD,
      Math.floor(getInitialGitHubMaxResults(settings.searchResultPages) / searchTerms.length),
    );

    return searchTerms.map((term) => {
      const query = `${term} in:name,description pushed:>${settings.lookbackDate}`;
      return {
        input: {
          query,
          sortBy: 'best-match',
          maxResults: maxResultsPerTerm,
        },
        query,
        displayQuery: term,
      };
    });
  }

  const primaryQuery = searchTerms.join(' OR ');
  const baseGoogleQuery = buildGoogleScannerQuery(actor.source, primaryQuery);
  const query = `${baseGoogleQuery} after:${settings.lookbackDate}`;
  const googlePageCount = getInitialGooglePageCount(settings.searchResultPages);

  return [{
    input: { queries: query, maxPagesPerQuery: googlePageCount },
    query,
    displayQuery: sanitizeGoogleQueryForDisplay(query),
  }];
}

/**
 * Start a single Apify actor run asynchronously (non-blocking).
 * Attaches a webhook so Apify notifies the app when the run completes.
 * The webhook URL must be publicly reachable (use ngrok for local dev).
 */
export async function startActorRun(
  actor: ActorConfig,
  brand: ActorRunBrandContext,
  settings: EffectiveScanSettings,
  webhookUrl: string,
): Promise<{ runId: string; query: string; displayQuery: string }> {
  const actorInputs = buildActorInputs(actor, brand, settings);
  if (actorInputs.length !== 1) {
    throw new Error(`startActorRun does not support batched inputs for ${actor.id}; use startActorRuns instead`);
  }

  const client = getClient();
  const { input, query, displayQuery } = actorInputs[0];
  const run = await client.actor(actor.actorId).start(input, buildActorStartOptions(actor, settings, webhookUrl));
  return { runId: run.id, query, displayQuery };
}

export async function startActorRuns(
  actor: ActorConfig,
  brand: ActorRunBrandContext,
  settings: EffectiveScanSettings,
  webhookUrl: string,
): Promise<StartActorRunsResult> {
  const client = getClient();
  const actorInputs = buildActorInputs(actor, brand, settings);
  let failedCount = 0;
  const runs: ActorRunStart[] = [];

  for (const { input, query, displayQuery } of actorInputs) {
    try {
      const run = await client.actor(actor.actorId).start(input, buildActorStartOptions(actor, settings, webhookUrl));
      runs.push({ runId: run.id, query, displayQuery });
    } catch (error) {
      failedCount += 1;
      console.error(`[apify] Failed to start ${actor.id} run for query "${displayQuery}":`, error);
    }
  }

  if (runs.length === 0) {
    throw new Error(`Failed to start any ${actor.displayName} runs`);
  }

  return { runs, failedCount };
}

/**
 * Start a deep-search actor run for a supported custom follow-up query.
 */
export async function startDeepSearchRun(
  params: {
    actor: ActorConfig;
    query: string;
    searchResultPages: number | undefined;
    lookbackDate: string | undefined;
    webhookUrl: string;
  },
): Promise<{ runId: string; query: string; displayQuery: string }> {
  const { actor, query, searchResultPages, lookbackDate, webhookUrl } = params;
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
    const baseQuery = buildGoogleScannerQuery(actor.source, trimmedQuery);
    executableQuery = lookbackDate ? `${baseQuery} after:${lookbackDate}` : baseQuery;
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
  brand: ActorRunBrandContext,
  settings: EffectiveScanSettings,
  webhookUrl?: string,
): Promise<ActorRunResult> {
  const client = getClient();
  const actorInputs = buildActorInputs(actor, brand, settings);
  if (actorInputs.length !== 1) {
    throw new Error(`runActor does not support batched inputs for ${actor.id}; use startActorRuns instead`);
  }

  const { input } = actorInputs[0];

  const runOptions: Record<string, unknown> = { input };
  if (actor.kind === 'discord') {
    runOptions.maxTotalChargeUsd = getInitialDiscordMaxTotalChargeUsd(settings.searchResultPages);
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

function buildActorStartOptions(
  actor: ActorConfig,
  settings: EffectiveScanSettings,
  webhookUrl: string,
): Record<string, unknown> {
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
    startOptions.maxTotalChargeUsd = getInitialDiscordMaxTotalChargeUsd(settings.searchResultPages);
  }

  return startOptions;
}

function getRequiredEnvVar(name: 'CODEPUNCH_API_KEY' | 'CODEPUNCH_API_SECRET' | 'OPENROUTER_API_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

