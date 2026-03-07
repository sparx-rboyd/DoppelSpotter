'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { broadcastAuthSyncEvent, useAuth } from '@/lib/auth/auth-context';
import { buildLoginRedirectHref } from '@/lib/auth/redirects';

export default function ChangePasswordPage() {
  const { signOut, user } = useAuth();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation must match.');
      return;
    }

    if (currentPassword === newPassword) {
      setError('New password must be different from your current password.');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      if (response.status === 401) {
        await signOut().catch(() => null);
        router.replace(buildLoginRedirectHref('/account/password'));
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to update password');
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      broadcastAuthSyncEvent('password-changed');
      setSuccess('Password changed');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthGuard>
      <Navbar />
      <main className="min-h-screen bg-gray-50 pt-16">
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Change password</h1>
            <p className="mt-1 text-sm text-gray-500">
              Update the password for {user?.email ?? 'your account'}.
            </p>
          </div>

          <Card className="max-w-2xl">
            <CardHeader className="flex flex-row items-start gap-4">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                <KeyRound className="h-5 w-5 text-brand-600" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900">Keep your account secure</h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">
                  Enter your current password, then choose a new one with at least 8 characters.
                  When you save it, older sessions will stop working.
                </p>
              </div>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium text-gray-700">
                    Current password
                  </label>
                  <input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Enter your current password"
                  />
                </div>

                <div>
                  <label htmlFor="newPassword" className="mb-1 block text-sm font-medium text-gray-700">
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
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Choose a new password"
                  />
                </div>

                <div>
                  <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium text-gray-700">
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
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Re-enter your new password"
                  />
                </div>

                {error && (
                  <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                    {error}
                  </p>
                )}

                {success && (
                  <p className="rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
                    {success}
                  </p>
                )}

                <div className="flex justify-end">
                  <Button type="submit" loading={loading}>
                    Save new password
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </AuthGuard>
  );
}
