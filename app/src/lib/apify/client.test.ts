import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrandScanSources } from '@/lib/brands';
import type { EffectiveScanSettings } from '@/lib/types';
import { getActorConfigByScannerId } from './actors';
import { buildActorInputs, buildDeepSearchPreparedInput } from './client';

const baseSettings: EffectiveScanSettings = {
  searchResultPages: 3,
  lookbackPeriod: '1year',
  lookbackDate: '2026-03-01',
  allowAiDeepSearches: true,
  maxAiDeepSearches: 3,
  scanSources: normalizeBrandScanSources({
    tiktok: true,
    github: true,
  }),
};

test('buildActorInputs keeps TikTok one-query-per-run', () => {
  const actor = getActorConfigByScannerId('tiktok-posts');
  const inputs = buildActorInputs(actor, {
    name: 'Sparx',
    keywords: ['Sparx Maths', 'sparx', 'Sparx Maths'],
  }, baseSettings);

  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].query, 'Sparx');
  assert.equal(inputs[0].displayQuery, 'Sparx');
  assert.deepEqual(inputs[0].input.keywords, ['Sparx']);
  assert.equal(inputs[1].query, 'Sparx Maths');
  assert.equal(inputs[1].displayQuery, 'Sparx Maths');
  assert.deepEqual(inputs[1].input.keywords, ['Sparx Maths']);
});

test('buildActorInputs keeps GitHub one-query-per-run', () => {
  const actor = getActorConfigByScannerId('github-repos');
  const inputs = buildActorInputs(actor, {
    name: 'Sparx',
    keywords: ['Sparx Maths'],
  }, baseSettings);

  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].displayQuery, 'Sparx');
  assert.equal(inputs[1].displayQuery, 'Sparx Maths');
  assert.match(inputs[0].query, /in:name,description pushed:>2026-03-01$/);
  assert.match(inputs[1].query, /in:name,description pushed:>2026-03-01$/);
});

test('buildDeepSearchPreparedInput produces queued-ready Google follow-up input', () => {
  const actor = getActorConfigByScannerId('google-youtube');
  const prepared = buildDeepSearchPreparedInput({
    actor,
    queries: ['sparx maths leaks'],
    searchResultPages: 4,
    lookbackDate: '2026-03-01',
  });

  assert.equal(prepared.displayQuery, 'sparx maths leaks');
  assert.deepEqual(prepared.displayQueries, ['sparx maths leaks']);
  assert.equal(prepared.query.includes('site:youtube.com'), true);
  assert.equal(prepared.input.maxPagesPerQuery, 4);
});

test('buildDeepSearchPreparedInput keeps X follow-up input single-query', () => {
  const actor = getActorConfigByScannerId('x-search');
  const prepared = buildDeepSearchPreparedInput({
    actor,
    queries: ['sparx maths'],
    searchResultPages: 5,
    lookbackDate: '2026-03-01',
  });

  assert.deepEqual(prepared.input.searchTerms, ['sparx maths']);
  assert.deepEqual(prepared.queries, ['sparx maths']);
  assert.deepEqual(prepared.displayQueries, ['sparx maths']);
});
