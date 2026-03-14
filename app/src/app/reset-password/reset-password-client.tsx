'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound, ScanEye } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { PASSWORD_RESET_TOKEN_MAX_AGE_LABEL } from '@/lib/password-reset';
import { usePageTitle } from '@/lib/use-page-title';

export default function ResetPasswordClient() {
  usePageTitle('Reset Password');
  const searchParams = useSearchParams();
  const token = useMemo(() => searchParams.get('token')?.trim() ?? '', [searchParams]);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (!token) {
      setError('This password reset link is invalid or has expired.');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation must match.');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          token,
          newPassword,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to reset password');
      }

      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Your password has been reset. You can now sign in with your new password.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred.');
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
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
              <KeyRound className="h-5 w-5 text-brand-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Set a new password</h1>
              <p className="mt-1 text-sm leading-6 text-gray-600">
                Choose a new password with at least 8 characters. Reset links stay valid for{' '}
                {PASSWORD_RESET_TOKEN_MAX_AGE_LABEL}.
              </p>
            </div>
          </div>

          {!token ? (
            <div className="mt-6 space-y-4">
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                This password reset link is invalid or incomplete.
              </p>
              <Link
                href="/forgot-password"
                className="inline-flex w-full items-center justify-center rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 lg:py-3"
              >
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4 lg:mt-7 lg:space-y-5">
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  New password
                </label>
                <input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 lg:py-3"
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm new password
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 lg:py-3"
                />
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              {success && (
                <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                  {success}
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
                Save new password
              </button>
            </form>
          )}

          <p className="mt-5 text-sm text-gray-600">
            Need another email?{' '}
            <Link href="/forgot-password" className="font-medium text-brand-700 hover:text-brand-800">
              Request a fresh reset link
            </Link>
          </p>

          <p className="mt-2 text-sm text-gray-600">
            Back to{' '}
            <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
              sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
