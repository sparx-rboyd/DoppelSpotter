import test from 'node:test';
import assert from 'node:assert/strict';
import type { Scan } from '@/lib/types';
import { getActorConfigByScannerId } from './actors';
import {
  buildActorRunInfoFromQueuedRun,
  buildPreparedActorInputFromQueuedRun,
  buildQueuedActorRunInfo,
  getApifyMaxLiveRunsPerScan,
  getLiveActorRunCount,
  hasQueuedActorLaunchWork,
} from './live-run-cap';

test('getApifyMaxLiveRunsPerScan defaults to 5 and ignores invalid env values', () => {
  const previous = process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN;

  delete process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN;
  assert.equal(getApifyMaxLiveRunsPerScan(), 5);

  process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN = '0';
  assert.equal(getApifyMaxLiveRunsPerScan(), 5);

  process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN = 'abc';
  assert.equal(getApifyMaxLiveRunsPerScan(), 5);

  process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN = '7';
  assert.equal(getApifyMaxLiveRunsPerScan(), 7);

  if (previous === undefined) {
    delete process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN;
  } else {
    process.env.APIFY_MAX_LIVE_RUNS_PER_SCAN = previous;
  }
});

test('getLiveActorRunCount only counts live Apify runs and launch reservations', () => {
  const scan = {
    actorRuns: {
      a: { scannerId: 'google-web', actorId: 'a', source: 'google', status: 'running' },
      b: { scannerId: 'google-web', actorId: 'b', source: 'google', status: 'pending' },
      c: { scannerId: 'google-web', actorId: 'c', source: 'google', status: 'waiting_for_preference_hints' },
      d: { scannerId: 'google-web', actorId: 'd', source: 'google', status: 'fetching_dataset' },
      e: { scannerId: 'google-web', actorId: 'e', source: 'google', status: 'analysing' },
      f: { scannerId: 'google-web', actorId: 'f', source: 'google', status: 'succeeded' },
    },
    launchingActorRuns: {
      one: {
        scannerId: 'x-search',
        actorId: 'one',
        source: 'x',
        launchId: 'launch-one',
        searchDepth: 1,
        input: { searchTerms: ['brand'] },
        searchQuery: 'brand',
        displayQuery: 'brand',
      },
      two: {
        scannerId: 'github-repos',
        actorId: 'two',
        source: 'github',
        launchId: 'launch-two',
        searchDepth: 0,
        input: { query: 'brand in:name,description' },
        searchQuery: 'brand in:name,description',
        displayQuery: 'brand',
      },
    },
  } satisfies Pick<Scan, 'actorRuns' | 'launchingActorRuns'>;

  assert.equal(getLiveActorRunCount(scan), 4);
});

test('hasQueuedActorLaunchWork checks queued and launching launches', () => {
  assert.equal(hasQueuedActorLaunchWork({
    queuedActorRuns: [],
    launchingActorRuns: {},
  }), false);

  assert.equal(hasQueuedActorLaunchWork({
    queuedActorRuns: [{
      scannerId: 'x-search',
      actorId: 'actor',
      source: 'x',
      launchId: 'queued-launch',
      searchDepth: 1,
      input: { searchTerms: ['brand'] },
      searchQuery: 'brand',
      displayQuery: 'brand',
    }],
    launchingActorRuns: {},
  }), true);
});

test('queued actor run helpers preserve serialized launch details', () => {
  const actor = getActorConfigByScannerId('github-repos');
  const queuedRun = buildQueuedActorRunInfo(actor, {
    input: { query: 'sparx in:name,description', maxResults: 10 },
    query: 'sparx in:name,description',
    displayQuery: 'sparx',
  }, 0);

  assert.deepEqual(buildPreparedActorInputFromQueuedRun(queuedRun), {
    input: { query: 'sparx in:name,description', maxResults: 10 },
    query: 'sparx in:name,description',
    displayQuery: 'sparx',
  });

  const runInfo = buildActorRunInfoFromQueuedRun(queuedRun, {
    query: queuedRun.searchQuery,
    displayQuery: queuedRun.displayQuery,
  });

  assert.equal(runInfo.scannerId, 'github-repos');
  assert.equal(runInfo.source, 'github');
  assert.equal(runInfo.searchDepth, 0);
  assert.equal(runInfo.status, 'running');
});

