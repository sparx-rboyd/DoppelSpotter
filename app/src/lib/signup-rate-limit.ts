import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import type { SignupRateLimitRecord } from '@/lib/types';

const SIGNUP_RATE_LIMIT_SCOPE = 'signup';
const DEFAULT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashRateLimitKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getClientIdentifier(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const ip = forwardedFor?.split(',')[0]?.trim() || realIp?.trim();
  if (ip) return `ip:${ip}`;

  const userAgent = request.headers.get('user-agent')?.trim();
  if (userAgent) return `ua:${userAgent}`;

  return 'unknown';
}

export interface SignupRateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
}

export async function consumeSignupRateLimit(request: NextRequest): Promise<SignupRateLimitResult> {
  const windowSeconds = parsePositiveIntegerEnv('SIGNUP_RATE_LIMIT_WINDOW_SECONDS', DEFAULT_WINDOW_SECONDS);
  const maxAttempts = parsePositiveIntegerEnv('SIGNUP_RATE_LIMIT_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const windowMs = windowSeconds * 1000;

  const identifier = getClientIdentifier(request);
  const keyHash = hashRateLimitKey(identifier);
  const docId = `${SIGNUP_RATE_LIMIT_SCOPE}:${keyHash}`;
  const rateLimitRef = db.collection('authRateLimits').doc(docId);
  const now = Date.now();

  return db.runTransaction<SignupRateLimitResult>(async (tx) => {
    const doc = await tx.get(rateLimitRef);

    if (!doc.exists) {
      tx.set(rateLimitRef, {
        scope: SIGNUP_RATE_LIMIT_SCOPE,
        keyHash,
        attemptCount: 1,
        windowStartedAt: new Date(now),
        lastAttemptAt: new Date(now),
      });
      return { ok: true };
    }

    const data = doc.data() as SignupRateLimitRecord;
    const windowStartedAtMs = data.windowStartedAt.toDate().getTime();
    const elapsedMs = now - windowStartedAtMs;

    if (elapsedMs >= windowMs) {
      tx.update(rateLimitRef, {
        attemptCount: 1,
        windowStartedAt: new Date(now),
        lastAttemptAt: new Date(now),
      });
      return { ok: true };
    }

    const nextAttemptCount = (data.attemptCount ?? 0) + 1;
    tx.update(rateLimitRef, {
      attemptCount: nextAttemptCount,
      lastAttemptAt: new Date(now),
    });

    if (nextAttemptCount > maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
      return { ok: false, retryAfterSeconds };
    }

    return { ok: true };
  });
}
