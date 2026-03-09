/**
 * CLI script to add invite codes to Firestore.
 *
 * Usage (from the app/ directory):
 *   npm run add-invite-code
 *   npm run add-invite-code -- --count 5
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 * Required vars: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS (local dev)
 * Optional vars: FIRESTORE_DATABASE_ID (defaults to "(default)")
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import { generateInviteCode, hashInviteCode } from '../src/lib/invite-codes';

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

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === 6 || maybeCode === '6' || maybeCode === 'ALREADY_EXISTS';
}

const rawCount = getArg('--count');
const count = rawCount ? Number.parseInt(rawCount, 10) : 1;

if (!Number.isFinite(count) || count < 1 || count > 100) {
  console.error('Usage: npm run add-invite-code -- [--count <1-100>]');
  process.exit(1);
}

const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
});

async function createOneInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);

    try {
      await db.collection('inviteCodes').doc(codeHash).create({
        codeHash,
        createdAt: FieldValue.serverTimestamp(),
      });
      return code;
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
  }

  throw new Error('Failed to generate a unique invite code after repeated attempts.');
}

async function main() {
  const codes = await Promise.all(Array.from({ length: count }, () => createOneInviteCode()));

  console.log(count === 1 ? 'Invite code created successfully.' : `Created ${count} invite codes successfully.`);
  for (const code of codes) {
    console.log(`  ${code}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
