'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Plus, Shield } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { FindingSummary } from '@/lib/types';

export default function DashboardPage() {
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function handleFindingNoteUpdate(triggerFinding: FindingSummary, note: string | null) {
    const res = await fetch(`/api/brands/${triggerFinding.brandId}/findings/${triggerFinding.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ bookmarkNote: note }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Failed to update note');
    }

    const json = await res.json().catch(() => ({}));
    const responseData = (json.data ?? {}) as {
      isBookmarked?: boolean;
      bookmarkNote?: string | null;
    };
    const isBookmarked = responseData.isBookmarked ?? triggerFinding.isBookmarked ?? false;
    const bookmarkNote = responseData.bookmarkNote ?? null;

    setFindings((prev) => prev.map((finding) => (
      finding.id === triggerFinding.id
        ? {
            ...finding,
            isBookmarked,
            bookmarkedAt: isBookmarked ? finding.bookmarkedAt : undefined,
            bookmarkNote: bookmarkNote ?? undefined,
          }
        : finding
    )));
  }

  useEffect(() => {
    async function fetchFindings() {
      setError('');
      try {
        const res = await fetch('/api/findings', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed to load findings');
        const json = await res.json();
        setFindings(json.data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchFindings();
  }, []);

  const highCount = findings.filter((f) => f.severity === 'high').length;

  return (
    <AuthGuard>
      <Navbar />

      <main className="pt-16 min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

          {/* Page header */}
          <div className="flex items-center justify-between mb-8 gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
              <p className="text-sm text-gray-500 mt-0.5">Live web data retrieved via Apify Actors</p>
            </div>
            <Link href="/brands/new">
              <Button size="sm">
                <Plus className="w-4 h-4" />
                Add Brand
              </Button>
            </Link>
          </div>

          {/* Findings panel */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            {/* Panel header */}
            <div className="px-6 py-5 border-b border-brand-100 flex items-center justify-between gap-4 bg-brand-50">
              <div>
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Recent Threats Detected</h2>
                <p className="text-xs sm:text-sm text-gray-500">
                  {loading
                    ? 'Loading…'
                    : findings.length > 0
                      ? `${findings.length} finding${findings.length !== 1 ? 's' : ''} across all monitored brands`
                      : 'No findings yet — run a scan to start monitoring'}
                </p>
              </div>
              {highCount > 0 && (
                <Badge variant="danger">
                  <AlertCircle className="w-3.5 h-3.5" />
                  {highCount} High Risk
                </Badge>
              )}
            </div>

            {/* Loading state */}
            {loading && (
              <div className="flex justify-center py-16">
                <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {/* Error state */}
            {!loading && error && (
              <div className="p-4 sm:p-6">
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                  {error}
                </p>
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && findings.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center">
                  <Shield className="w-5 h-5 text-brand-600" />
                </div>
                <p className="text-sm text-gray-500">No findings yet. Run a scan on a brand to see results here.</p>
              </div>
            )}

            {/* Findings list */}
            {!loading && !error && findings.length > 0 && (
              <div className="p-4 sm:p-6 space-y-4">
                {findings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onNoteUpdate={handleFindingNoteUpdate}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Getting started hint — shown when no findings exist */}
          {!loading && findings.length === 0 && (
            <div className="mt-6 bg-brand-50 border border-brand-100 rounded-xl p-5 text-sm text-brand-700">
              <strong>Getting started:</strong> Add a brand to begin monitoring.
              DoppelSpotter will scan social media, newly-registered domains, Google Search, and app stores for potential infringements.{' '}
              <Link href="/brands/new" className="font-semibold underline hover:no-underline">
                Add your first brand →
              </Link>
            </div>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
