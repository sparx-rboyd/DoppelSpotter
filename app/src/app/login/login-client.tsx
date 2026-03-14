'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ScanEye } from 'lucide-react';
import { useAuth, broadcastAuthSyncEvent } from '@/lib/auth/auth-context';
import { resolveSafeReturnTo } from '@/lib/auth/redirects';
import { usePageTitle } from '@/lib/use-page-title';

export default function LoginClient() {
  usePageTitle('Sign In');
  const { user, loading: authLoading, refreshSession } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const emailFromUrl = searchParams.get('email')?.trim() ?? '';
  const [email, setEmail] = useState(emailFromUrl);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const returnTo = resolveSafeReturnTo(searchParams.get('returnTo'));

  useEffect(() => {
    if (!emailFromUrl) return;
    setEmail(emailFromUrl);
  }, [emailFromUrl]);

  useEffect(() => {
    if (authLoading || !user) return;
    router.replace(returnTo);
  }, [authLoading, returnTo, router, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.errorCode === 'EMAIL_NOT_VERIFIED') {
          const params = new URLSearchParams({ email: data.email ?? email });
          router.replace(`/verify-email?${params.toString()}`);
          return;
        }
        throw new Error(data.error ?? 'Sign in failed');
      }

      await refreshSession();
      broadcastAuthSyncEvent('signed-in');
      router.replace(returnTo);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="hero-pattern flex min-h-screen items-center justify-center px-4 py-8 lg:px-6 lg:py-10">
      <div className="w-full max-w-sm lg:max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2 lg:mb-8 lg:gap-2.5">
          <ScanEye className="h-8 w-8 text-brand-600 lg:h-9 lg:w-9" />
          <span className="font-bold text-xl tracking-tight text-gray-900">DoppelSpotter</span>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-8 lg:rounded-[1.75rem] lg:p-10">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Sign in to your account</h1>
          <p className="text-sm text-gray-600">Invite-only registration is now open for a limited number of new accounts.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4 lg:mt-7 lg:space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 lg:py-3"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 lg:py-3"
              />
              <div className="mt-2 flex justify-end">
                <Link href="/forgot-password" className="text-sm font-medium text-brand-700 hover:text-brand-800">
                  Forgotten your password?
                </Link>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-brand-600 py-2.5 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60 lg:py-3"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : null}
              Sign in
            </button>
          </form>

          <p className="mt-6 text-sm text-gray-600 text-center">
            Have an invite code?{' '}
            <Link href="/signup" className="font-medium text-brand-700 hover:text-brand-800">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
