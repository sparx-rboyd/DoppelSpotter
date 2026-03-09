'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ScanEye } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { resolveSafeReturnTo } from '@/lib/auth/redirects';

export default function SignupClient() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const returnTo = resolveSafeReturnTo(searchParams.get('returnTo'));

  useEffect(() => {
    if (authLoading || !user) return;
    router.replace(returnTo);
  }, [authLoading, returnTo, router, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password, inviteCode }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Sign up failed');
      }

      const data = await res.json();
      const params = new URLSearchParams({ email: data.email ?? email });
      router.replace(`/verify-email?${params.toString()}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen hero-pattern flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <ScanEye className="text-brand-600 w-8 h-8" />
          <span className="font-bold text-xl tracking-tight text-gray-900">DoppelSpotter</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Create your account</h1>
          <p className="text-sm text-gray-600">Registration is invite-only. Enter your 10-character invite code to continue.</p>

          <form onSubmit={handleSubmit} className="space-y-4 mt-6">
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
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label htmlFor="inviteCode" className="block text-sm font-medium text-gray-700 mb-1">
                Invite code
              </label>
              <input
                id="inviteCode"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={10}
                maxLength={10}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toLowerCase().replace(/\s+/g, '').slice(0, 10))}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 tracking-[0.2em] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-full transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : null}
              Create account
            </button>
          </form>

          <p className="mt-6 text-sm text-gray-600 text-center">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
