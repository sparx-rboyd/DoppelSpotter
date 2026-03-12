'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import { useRouter } from 'next/navigation';
import { AlertTriangle, KeyRound, Trash2 } from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { broadcastAuthSyncEvent, useAuth } from '@/lib/auth/auth-context';
import { buildLoginRedirectHref } from '@/lib/auth/redirects';

export default function SettingsPage() {
  usePageTitle('Account Settings');
  const { signOut, user, refreshSession } = useAuth();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [skipDomainVisitWarning, setSkipDomainVisitWarning] = useState(false);
  const [savingDomainVisitWarning, setSavingDomainVisitWarning] = useState(false);
  const [domainVisitWarningError, setDomainVisitWarningError] = useState('');
  const [domainVisitWarningSuccess, setDomainVisitWarningSuccess] = useState('');

  useEffect(() => {
    setSkipDomainVisitWarning(user?.preferences?.skipDomainRegistrationVisitWarning === true);
  }, [user?.preferences?.skipDomainRegistrationVisitWarning]);

  useEffect(() => {
    if (!isDeleteDialogOpen || deleting) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsDeleteDialogOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleteDialogOpen, deleting]);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation must match.');
      return;
    }

    if (currentPassword === newPassword) {
      setPasswordError('New password must be different from your current password.');
      return;
    }

    setPasswordLoading(true);

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
        router.replace(buildLoginRedirectHref('/settings'));
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
      setPasswordSuccess('Password changed');
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'An unexpected error occurred.');
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleDeleteAccount() {
    if (deleting) return;

    setDeleting(true);
    setDeleteError('');

    try {
      const response = await fetch('/api/auth/delete-account', {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (response.status === 401) {
        await signOut().catch(() => null);
        router.replace(buildLoginRedirectHref('/settings'));
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to delete account');
      }

      await signOut().catch(() => {
        broadcastAuthSyncEvent('signed-out');
      });
      router.replace('/login');
      router.refresh();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'An unexpected error occurred.');
      setDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  }

  async function handleDomainVisitWarningToggle(nextValue: boolean) {
    if (savingDomainVisitWarning) return;

    setSavingDomainVisitWarning(true);
    setDomainVisitWarningError('');
    setDomainVisitWarningSuccess('');

    try {
      const response = await fetch('/api/settings/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          skipDomainRegistrationVisitWarning: nextValue,
        }),
      });

      if (response.status === 401) {
        await signOut().catch(() => null);
        router.replace(buildLoginRedirectHref('/settings'));
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to update setting');
      }

      setSkipDomainVisitWarning(nextValue);
      setDomainVisitWarningSuccess(
        nextValue
          ? 'Domain visit warning disabled'
          : 'Domain visit warning enabled',
      );
      await refreshSession();
    } catch (error) {
      setDomainVisitWarningError(error instanceof Error ? error.message : 'An unexpected error occurred.');
    } finally {
      setSavingDomainVisitWarning(false);
    }
  }

  return (
    <AuthGuard>
      <Navbar />
      <main className="min-h-screen bg-gray-50 pt-16">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader className="px-6 py-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                    <KeyRound className="h-5 w-5 text-brand-600" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900">Change password</h2>
                    <p className="mt-1 text-sm leading-6 text-gray-600">
                      Confirm your current password, then choose a new one (minumum 8 characters).
                    </p>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-6">
                <form onSubmit={handlePasswordSubmit} className="space-y-5">
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

                  {passwordError && (
                    <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                      {passwordError}
                    </p>
                  )}

                  {passwordSuccess && (
                    <p className="rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
                      {passwordSuccess}
                    </p>
                  )}

                  <div className="flex justify-end">
                    <Button type="submit" loading={passwordLoading} disabled={deleting}>
                      Save new password
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-6 py-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-amber-50">
                    <AlertTriangle className="h-5 w-5 text-amber-600" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900">Domain visit warning</h2>
                    <p className="mt-1 text-sm leading-6 text-gray-600">
                      Control whether DoppelSpotter warns you before opening domain registration findings, which can sometimes host inappropriate content.
                    </p>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-6">
                <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium text-gray-900">Warn before opening domain registration findings</p>
                    <p className="text-sm text-gray-500">
                      Turn this back on at any time if you previously chose “Don&apos;t show me this again”.
                    </p>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={!skipDomainVisitWarning}
                    disabled={savingDomainVisitWarning}
                    onClick={() => void handleDomainVisitWarningToggle(!skipDomainVisitWarning)}
                    className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 ${!skipDomainVisitWarning ? 'bg-brand-600' : 'bg-gray-300'}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${!skipDomainVisitWarning ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                  </button>
                </div>

                {domainVisitWarningError && (
                  <p className="mt-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                    {domainVisitWarningError}
                  </p>
                )}

                {domainVisitWarningSuccess && (
                  <p className="mt-4 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
                    {domainVisitWarningSuccess}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="border-red-200 bg-red-50/40">
              <CardHeader className="px-6 py-5">
                <h2 className="font-semibold text-red-700">Danger zone</h2>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 bg-red-50/40 p-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium text-gray-900">Delete your account</p>
                  <p className="text-sm text-gray-500">
                    Permanently delete your account, brands, scans, findings, and saved preferences.
                    This action cannot be undone.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="danger"
                  loading={deleting}
                  disabled={passwordLoading}
                  onClick={() => {
                    setDeleteError('');
                    setIsDeleteDialogOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete account
                </Button>
              </CardContent>
            </Card>

            {deleteError && (
              <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                {deleteError}
              </p>
            )}
          </div>
        </div>

        {isDeleteDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 px-4 py-4"
            onClick={() => {
              if (!deleting) {
                setIsDeleteDialogOpen(false);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-account-title"
              aria-describedby="delete-account-description"
              className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
                  <Trash2 className="h-5 w-5 text-red-600" />
                </div>
                <div className="min-w-0">
                  <h2 id="delete-account-title" className="text-lg font-semibold text-gray-900">
                    Delete your account?
                  </h2>
                  <p id="delete-account-description" className="mt-2 text-sm leading-6 text-gray-600">
                    This will permanently delete {user?.email ?? 'this account'} and all associated
                    brands, scans, findings, and saved settings.
                  </p>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={deleting}
                  onClick={() => setIsDeleteDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="button" variant="danger" loading={deleting} onClick={handleDeleteAccount}>
                  Delete account
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}
