/**
 * Backfill script: compute and write denormalized severity counts onto all existing
 * scan documents that are missing them.
 *
 * The webhook now writes these counts at scan-completion time, and the PATCH handler
 * keeps them up to date on ignore/un-ignore. This script brings existing scans into
 * sync by reading each scan's findings from the `findings` collection.
 *
 * Usage (from the app/ directory):
 *   npm run backfill-scan-counts
 *
 * Safe to run multiple times — it only updates scans where at least one count field
 * is missing (null/undefined). Pass --force to update all scans regardless.
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 * Required vars: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS (local dev)
 * Optional vars: FIRESTORE_DATABASE_ID (defaults to "(default)")
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Firestore } from '@google-cloud/firestore';

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
});

async function main() {
  console.log(`Fetching all scans…${force ? ' (--force: will update all)' : ''}`);

  const scansSnap = await db.collection('scans').get();
  console.log(`Found ${scansSnap.size} scan(s) total.`);

  const toUpdate = force
    ? scansSnap.docs
    : scansSnap.docs.filter((doc) => {
        const d = doc.data();
        return (
          d.highCount == null ||
          d.mediumCount == null ||
          d.lowCount == null ||
          d.nonHitCount == null ||
          d.ignoredCount == null
        );
      });

  if (toUpdate.length === 0) {
    console.log('All scans already have count fields. Nothing to do.');
    return;
  }

  console.log(`Updating ${toUpdate.length} scan(s)…`);

  // Fetch all findings in one query (projected fields only)
  const findingsSnap = await db
    .collection('findings')
    .select('scanId', 'severity', 'isFalsePositive', 'isIgnored')
    .get();

  console.log(`Fetched ${findingsSnap.size} finding(s).`);

  type Counts = { high: number; medium: number; low: number; nonHit: number; ignored: number };
  const countsByScanId = new Map<string, Counts>();

  for (const doc of findingsSnap.docs) {
    const { scanId, severity, isFalsePositive, isIgnored } = doc.data() as {
      scanId: string;
      severity: string;
      isFalsePositive?: boolean;
      isIgnored?: boolean;
    };
    if (!scanId) continue;
    if (!countsByScanId.has(scanId)) {
      countsByScanId.set(scanId, { high: 0, medium: 0, low: 0, nonHit: 0, ignored: 0 });
    }
    const counts = countsByScanId.get(scanId)!;
    // isFalsePositive findings are always nonHits, even if also auto-ignored.
    // isIgnored without isFalsePositive = user manually dismissed.
    if (isFalsePositive) {
      counts.nonHit++;
    } else if (isIgnored) {
      counts.ignored++;
    } else if (severity === 'high') {
      counts.high++;
    } else if (severity === 'medium') {
      counts.medium++;
    } else if (severity === 'low') {
      counts.low++;
    }
  }

  // Write updates in batches of 500
  const BATCH_LIMIT = 500;
  let updated = 0;

  for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = toUpdate.slice(i, i + BATCH_LIMIT);

    for (const scanDoc of chunk) {
      const counts = countsByScanId.get(scanDoc.id) ?? { high: 0, medium: 0, low: 0, nonHit: 0, ignored: 0 };
      batch.update(scanDoc.ref, {
        highCount: counts.high,
        mediumCount: counts.medium,
        lowCount: counts.low,
        nonHitCount: counts.nonHit,
        ignoredCount: counts.ignored,
      });
      updated++;
    }

    await batch.commit();
    console.log(`  Committed batch: ${Math.min(i + BATCH_LIMIT, toUpdate.length)} / ${toUpdate.length}`);
  }

  console.log(`Done. Updated ${updated} scan(s).`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
