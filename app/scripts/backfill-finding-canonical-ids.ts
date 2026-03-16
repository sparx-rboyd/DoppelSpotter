/**
 * Backfill script: compute and persist source-specific finding `canonicalId` values
 * for existing finding documents.
 *
 * Usage (from the app/ directory):
 *   npm run backfill-finding-canonical-ids
 *   npm run backfill-finding-canonical-ids -- --force
 *
 * Safe to run multiple times. By default it only updates findings missing a
 * `canonicalId`. Pass --force to recompute all findings.
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Firestore, type DocumentReference } from '@google-cloud/firestore';
import type { FindingSource } from '../src/lib/types';

const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  const lines = readFileSync(envLocalPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const force = process.argv.includes('--force');
const BATCH_LIMIT = 500;

const TRACKING_QUERY_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'msclkid',
]);

const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
});

type FindingBackfillData = {
  source?: FindingSource;
  url?: string;
  rawData?: Record<string, unknown>;
  canonicalId?: string;
};

function normalizeStoredCanonicalId(canonicalId: unknown, options?: { lowerCase?: boolean }): string | null {
  if (typeof canonicalId !== 'string') {
    return null;
  }

  const trimmed = canonicalId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return options?.lowerCase ? trimmed.toLowerCase() : trimmed;
}

function normalizeUrlForFinding(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }

    const keptParams = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_QUERY_PARAM_NAMES.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
      );

    parsed.search = '';
    for (const [key, value] of keptParams) {
      parsed.searchParams.append(key, value);
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    const normalized = parsed.toString().replace(/\/$/, '');
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function extractRedditPermalinkParts(url: string): { postId: string } | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('reddit.com')) {
      return null;
    }

    const segments = parsed.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length < 4 || segments[0] !== 'r' || segments[2] !== 'comments') {
      return null;
    }

    const postId = segments[3];
    return postId ? { postId } : null;
  } catch {
    return null;
  }
}

function extractRedditPostIdFromUrl(url?: string): string | undefined {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return undefined;
  }

  return extractRedditPermalinkParts(url)?.postId;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getString(value: unknown, options?: { lowerCase?: boolean }): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return options?.lowerCase ? trimmed.toLowerCase() : trimmed;
}

function computeCanonicalId(source: FindingSource | undefined, data: FindingBackfillData): string | null {
  switch (source) {
    case 'google':
    case 'youtube':
    case 'facebook':
    case 'instagram':
    case 'telegram':
    case 'apple_app_store':
    case 'google_play':
      return (typeof data.url === 'string' ? normalizeUrlForFinding(data.url) : null)
        ?? normalizeStoredCanonicalId(data.canonicalId);

    case 'reddit': {
      const post = getObject(data.rawData)?.post;
      return getString(getObject(post)?.id)
        ?? extractRedditPostIdFromUrl(typeof data.url === 'string' ? data.url : undefined)
        ?? normalizeStoredCanonicalId(data.canonicalId);
    }

    case 'tiktok': {
      const video = getObject(data.rawData)?.video;
      return getString(getObject(video)?.id)
        ?? normalizeStoredCanonicalId(data.canonicalId);
    }

    case 'discord': {
      const server = getObject(data.rawData)?.server;
      return getString(getObject(server)?.id)
        ?? normalizeStoredCanonicalId(data.canonicalId);
    }

    case 'domains': {
      const domainRecord = getObject(data.rawData)?.domainRecord;
      const storedUrl = typeof data.url === 'string' ? data.url : getString(getObject(domainRecord)?.url);
      const urlHost = storedUrl
        ? (() => {
            try {
              return getString(new URL(storedUrl).hostname, { lowerCase: true });
            } catch {
              return null;
            }
          })()
        : null;

      return getString(getObject(domainRecord)?.domain, { lowerCase: true })
        ?? urlHost
        ?? normalizeStoredCanonicalId(data.canonicalId, { lowerCase: true });
    }

    case 'github': {
      const repo = getObject(data.rawData)?.repo;
      const repoFullName = getString(getObject(repo)?.fullName, { lowerCase: true });
      if (repoFullName) {
        return repoFullName;
      }

      if (typeof data.url === 'string') {
        try {
          const parsed = new URL(data.url);
          const segments = parsed.pathname
            .split('/')
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0);
          if (segments.length >= 2) {
            return `${segments[0]}/${segments[1]}`.toLowerCase();
          }
        } catch {
          // Ignore URL parsing failures and fall through to the existing value.
        }
      }

      return normalizeStoredCanonicalId(data.canonicalId, { lowerCase: true });
    }

    case 'euipo': {
      const trademark = getObject(data.rawData)?.trademark;
      return getString(getObject(trademark)?.applicationNumber)
        ?? normalizeStoredCanonicalId(data.canonicalId);
    }

    case 'x': {
      const tweet = getObject(data.rawData)?.tweet;
      return getString(getObject(tweet)?.id)
        ?? normalizeStoredCanonicalId(data.canonicalId);
    }

    default:
      return normalizeStoredCanonicalId(data.canonicalId);
  }
}

async function main() {
  console.log(`Fetching findings…${force ? ' (--force: will recompute all)' : ''}`);

  const findingsSnap = await db
    .collection('findings')
    .select('source', 'url', 'rawData', 'canonicalId')
    .get();

  console.log(`Found ${findingsSnap.size} finding(s) total.`);

  const candidates = force
    ? findingsSnap.docs
    : findingsSnap.docs.filter((doc) => normalizeStoredCanonicalId((doc.data() as FindingBackfillData).canonicalId) === null);

  if (candidates.length === 0) {
    console.log('All findings already have canonicalId values. Nothing to do.');
    return;
  }

  console.log(`Processing ${candidates.length} finding(s)…`);

  const updates: Array<{ ref: DocumentReference; canonicalId: string }> = [];
  let skipped = 0;

  for (const doc of candidates) {
    const data = doc.data() as FindingBackfillData;
    const canonicalId = computeCanonicalId(data.source, data);
    if (!canonicalId) {
      skipped++;
      continue;
    }

    const existingCanonicalId = normalizeStoredCanonicalId(data.canonicalId, {
      lowerCase: data.source === 'domains' || data.source === 'github',
    });
    if (existingCanonicalId === canonicalId) {
      continue;
    }

    updates.push({ ref: doc.ref, canonicalId });
  }

  if (updates.length === 0) {
    console.log(`No writes needed.${skipped > 0 ? ` Skipped ${skipped} finding(s) without a derivable canonicalId.` : ''}`);
    return;
  }

  let updated = 0;
  for (let index = 0; index < updates.length; index += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = updates.slice(index, index + BATCH_LIMIT);

    for (const item of chunk) {
      batch.update(item.ref, { canonicalId: item.canonicalId });
      updated++;
    }

    await batch.commit();
    console.log(`  Committed batch: ${Math.min(index + BATCH_LIMIT, updates.length)} / ${updates.length}`);
  }

  console.log(`Done. Updated ${updated} finding(s).`);
  if (skipped > 0) {
    console.log(`Skipped ${skipped} finding(s) without a derivable canonicalId.`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
