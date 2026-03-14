'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, ScanEye } from 'lucide-react';
import { EMAIL_VERIFICATION_TOKEN_MAX_AGE_LABEL, EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE } from '@/lib/email-verification';
import { usePageTitle } from '@/lib/use-page-title';

type PageState = 'pending' | 'check-email' | 'success';

export default function VerifyEmailClient() {
  usePageTitle('Verify Email');
  const searchParams = useSearchParams();
  const router = useRouter();

  const token = useMemo(() => searchParams.get('token')?.trim() ?? '', [searchParams]);
  const emailFromUrl = useMemo(() => searchParams.get('email')?.trim() ?? '', [searchParams]);
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const loginHref = useMemo(() => {
    const email = verifiedEmail || emailFromUrl;
    if (!email) return '/login';

    const params = new URLSearchParams({ email });
    return `/login?${params.toString()}`;
  }, [emailFromUrl, verifiedEmail]);

  const [state, setState] = useState<PageState>(token ? 'pending' : 'check-email');
  const [verifyError, setVerifyError] = useState('');
  const [resendEmail, setResendEmail] = useState(emailFromUrl);
  const [resendError, setResendError] = useState('');
  const [resendSuccess, setResendSuccess] = useState('');
  const [resendLoading, setResendLoading] = useState(false);

  // Guard against React Strict Mode double-firing
  const didAttempt = useRef(false);

  useEffect(() => {
    if (!token || didAttempt.current) return;
    didAttempt.current = true;

    void (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setVerifyError(data.error ?? 'This verification link is invalid or has expired.');
          setState('check-email');
          return;
        }

        const data = await res.json().catch(() => ({}));
        setVerifiedEmail(data.email ?? '');
        setState('success');
      } catch {
        setVerifyError('Unable to verify your email right now. Please try again.');
        setState('check-email');
      }
    })();
  }, [token]);

  useEffect(() => {
    if (state !== 'success') return;
    const timer = setTimeout(() => router.replace(loginHref), 1500);
    return () => clearTimeout(timer);
  }, [state, router, loginHref]);

  async function handleResend(e: FormEvent) {
    e.preventDefault();
    setResendError('');
    setResendSuccess('');
    setResendLoading(true);

    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: resendEmail }),
      });

      const data = await res.json().catch(() => ({}));
      setResendSuccess(data.message ?? EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE);
    } catch {
      setResendError('Unable to send the email right now. Please try again.');
    } finally {
      setResendLoading(false);
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
          {state === 'pending' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <span className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-600">Verifying your email…</p>
            </div>
          )}

          {state === 'success' && (
            <div className="text-center py-4 space-y-3">
              <p className="text-xl font-bold text-gray-900">Email verified!</p>
              <p className="text-sm text-gray-600">Redirecting you to sign in…</p>
              <Link
                href={loginHref}
                className="inline-flex items-center justify-center rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 lg:px-5 lg:py-2.5"
              >
                Continue to sign in
              </Link>
            </div>
          )}

          {state === 'check-email' && (
            <>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                  <Mail className="h-5 w-5 text-brand-600" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Check your email</h1>
                  <p className="mt-1 text-sm leading-6 text-gray-600">
                    We sent a verification link to your email address. Links expire after{' '}
                    {EMAIL_VERIFICATION_TOKEN_MAX_AGE_LABEL}.
                  </p>
                </div>
              </div>

              {verifyError && (
                <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {verifyError}
                </p>
              )}

              <form onSubmit={handleResend} className="mt-6 space-y-4 lg:mt-7 lg:space-y-5">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 lg:py-3"
                  />
                </div>

                {resendError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                    {resendError}
                  </p>
                )}

                {resendSuccess && (
                  <p className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                    {resendSuccess}. Check your inbox.
                  </p>
                )}

                <button
                  type="submit"
                  disabled={resendLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-brand-600 py-2.5 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60 lg:py-3"
                >
                  {resendLoading ? (
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : null}
                  Send a new verification email
                </button>
              </form>

              <p className="mt-5 text-sm text-gray-600">
                Already verified?{' '}
                <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
