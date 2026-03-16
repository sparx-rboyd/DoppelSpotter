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

test('buildActorInputs produces a single EUIPO run with all keywords combined', () => {
  const actor = getActorConfigByScannerId('euipo-trademarks');
  const previousClientId = process.env.EUIPO_API_KEY;
  const previousClientSecret = process.env.EUIPO_API_SECRET;
  process.env.EUIPO_API_KEY = 'euipo-client-id';
  process.env.EUIPO_API_SECRET = 'euipo-client-secret';

  try {
    const inputs = buildActorInputs(actor, {
      name: 'Sparx',
      keywords: ['Sparx Maths'],
    }, baseSettings);

    // Single run regardless of how many keywords are provided
    assert.equal(inputs.length, 1);
    // keywords array contains all deduplicated terms (brand name + keywords)
    assert.deepEqual(inputs[0].input.keywords, ['Sparx', 'Sparx Maths']);
    assert.equal(inputs[0].input.dateFrom, '2026-03-01');
    assert.equal(inputs[0].input.clientId, 'euipo-client-id');
    assert.equal(inputs[0].input.clientSecret, 'euipo-client-secret');
    assert.match(String(inputs[0].input.dateTo), /^\d{4}-\d{2}-\d{2}$/);
    // searchResultPages=3 → 3 * 50 = 150 total
    assert.equal(inputs[0].input.maxResults, 150);
    // displayQuery is joined from all terms
    assert.equal(inputs[0].displayQuery, 'Sparx | Sparx Maths');
  } finally {
    process.env.EUIPO_API_KEY = previousClientId;
    process.env.EUIPO_API_SECRET = previousClientSecret;
  }
});

test('buildActorInputs EUIPO single run budget scales with search depth', () => {
  const actor = getActorConfigByScannerId('euipo-trademarks');
  const previousClientId = process.env.EUIPO_API_KEY;
  const previousClientSecret = process.env.EUIPO_API_SECRET;
  process.env.EUIPO_API_KEY = 'euipo-client-id';
  process.env.EUIPO_API_SECRET = 'euipo-client-secret';

  try {
    const inputs = buildActorInputs(actor, {
      name: 'Sparx',
      keywords: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
    }, {
      ...baseSettings,
      searchResultPages: 1,
    });

    // Always a single run — all keywords in one actor invocation
    assert.equal(inputs.length, 1);
    // searchResultPages=1 → 1 * 50 = 50 total
    assert.equal(inputs[0].input.maxResults, 50);
    assert.ok(Array.isArray(inputs[0].input.keywords));
    assert.equal(inputs[0].input.keywords.length, 11); // brand name + 10 keywords
  } finally {
    process.env.EUIPO_API_KEY = previousClientId;
    process.env.EUIPO_API_SECRET = previousClientSecret;
  }
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
