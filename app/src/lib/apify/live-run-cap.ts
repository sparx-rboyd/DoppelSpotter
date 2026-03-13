import type { ActorConfig } from '@/lib/apify/actors';
import type { ActorRunInfo, QueuedActorRunInfo, Scan } from '@/lib/types';
import type { PreparedActorInput } from './client';

const DEFAULT_APIFY_MAX_LIVE_RUNS_PER_SCAN = 5;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getApifyMaxLiveRunsPerScan(): number {
  return parsePositiveIntegerEnv('APIFY_MAX_LIVE_RUNS_PER_SCAN', DEFAULT_APIFY_MAX_LIVE_RUNS_PER_SCAN);
}

export function buildQueuedActorRunInfo(
  actorConfig: ActorConfig,
  preparedInput: PreparedActorInput,
  searchDepth: 0 | 1,
): QueuedActorRunInfo {
  return {
    scannerId: actorConfig.id,
    actorId: actorConfig.actorId,
    source: actorConfig.source,
    searchDepth,
    input: preparedInput.input,
    searchQuery: preparedInput.query,
    ...(preparedInput.queries && preparedInput.queries.length > 0 ? { searchQueries: preparedInput.queries } : {}),
    displayQuery: preparedInput.displayQuery,
    ...(preparedInput.displayQueries && preparedInput.displayQueries.length > 0 ? { displayQueries: preparedInput.displayQueries } : {}),
  };
}

export function buildPreparedActorInputFromQueuedRun(queuedRun: QueuedActorRunInfo): PreparedActorInput {
  return {
    input: queuedRun.input,
    query: queuedRun.searchQuery,
    ...(queuedRun.searchQueries && queuedRun.searchQueries.length > 0 ? { queries: queuedRun.searchQueries } : {}),
    displayQuery: queuedRun.displayQuery,
    ...(queuedRun.displayQueries && queuedRun.displayQueries.length > 0 ? { displayQueries: queuedRun.displayQueries } : {}),
  };
}

export function buildActorRunInfoFromQueuedRun(
  queuedRun: QueuedActorRunInfo,
  startedRun: {
    query: string;
    queries?: string[];
    displayQuery: string;
    displayQueries?: string[];
  },
): ActorRunInfo {
  return {
    scannerId: queuedRun.scannerId,
    actorId: queuedRun.actorId,
    source: queuedRun.source,
    status: 'running',
    skippedDuplicateCount: 0,
    searchDepth: queuedRun.searchDepth,
    searchQuery: startedRun.query,
    ...(startedRun.queries && startedRun.queries.length > 0 ? { searchQueries: startedRun.queries } : {}),
    displayQuery: startedRun.displayQuery,
    ...(startedRun.displayQueries && startedRun.displayQueries.length > 0 ? { displayQueries: startedRun.displayQueries } : {}),
  };
}

export function isActorRunLiveOnApify(run?: Pick<ActorRunInfo, 'status'>): boolean {
  return run?.status === 'pending' || run?.status === 'running';
}

export function isActorRunInFlight(run?: Pick<ActorRunInfo, 'status'>): boolean {
  return run?.status === 'pending'
    || run?.status === 'running'
    || run?.status === 'waiting_for_preference_hints'
    || run?.status === 'fetching_dataset'
    || run?.status === 'analysing';
}

export function hasQueuedActorLaunchWork(scan: Pick<Scan, 'queuedActorRuns' | 'launchingActorRuns'>): boolean {
  return (scan.queuedActorRuns?.length ?? 0) > 0 || Object.keys(scan.launchingActorRuns ?? {}).length > 0;
}

export function getLiveActorRunCount(scan: Pick<Scan, 'actorRuns' | 'launchingActorRuns'>): number {
  const liveRuns = Object.values(scan.actorRuns ?? {}).filter((run) => isActorRunLiveOnApify(run)).length;
  const launchingRuns = Object.keys(scan.launchingActorRuns ?? {}).length;
  return liveRuns + launchingRuns;
}

