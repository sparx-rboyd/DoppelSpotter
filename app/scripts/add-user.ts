/**
 * CLI script to add a user to Firestore.
 *
 * Usage (from the app/ directory):
 *   npm run add-user -- --email user@example.com --password secret123
 *
 * Reads env vars from .env.local (same file used by `next dev`).
 * Required vars: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS (local dev)
 * Optional vars: FIRESTORE_DATABASE_ID (defaults to "(default)")
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Firestore, FieldValue } from '@google-cloud/firestore';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Load .env.local (dotenv/config only picks up .env by default)
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

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const email = getArg('--email');
const password = getArg('--password');

if (!email || !password) {
  console.error('Usage: npm run add-user -- --email <email> --password <password>');
  process.exit(1);
}

if (!email.includes('@')) {
  console.error('Error: invalid email address.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Error: password must be at least 8 characters.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
});

const normalizedEmail = email.trim().toLowerCase();

async function main() {
  const existing = await db
    .collection('users')
    .where('email', '==', normalizedEmail)
    .limit(1)
    .get();

  if (!existing.empty) {
    console.error(`Error: an account with email "${normalizedEmail}" already exists.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userRef = db.collection('users').doc();

  await userRef.set({
    email: normalizedEmail,
    passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });

  console.log(`User created successfully.`);
  console.log(`  ID:    ${userRef.id}`);
  console.log(`  Email: ${normalizedEmail}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
