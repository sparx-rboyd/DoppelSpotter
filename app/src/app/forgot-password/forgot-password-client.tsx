'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Mail, ScanEye } from 'lucide-react';
import { PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE, PASSWORD_RESET_TOKEN_MAX_AGE_LABEL } from '@/lib/password-reset';

export default function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSuccess('');

    setLoading(true);

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });

      const data = await response.json().catch(() => ({}));
      setSuccess(data.message ?? PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE);
    } catch {
      setError('Unable to request a password reset right now. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen hero-pattern flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <ScanEye className="text-brand-600 w-8 h-8" />
          <span className="font-bold text-xl tracking-tight text-gray-900">DoppelSpotter</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
              <Mail className="h-5 w-5 text-brand-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Forgotten your password?</h1>
              <p className="mt-1 text-sm leading-6 text-gray-600">
                Enter your account email address and, if it matches an account, we&apos;ll send a reset
                link.
              </p>
            </div>
          </div>

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
                onChange={(event) => setEmail(event.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {success && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                {success}.
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
              Send reset email
            </button>
          </form>

          <p className="mt-5 text-sm text-gray-600">
            Remembered it?{' '}
            <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
