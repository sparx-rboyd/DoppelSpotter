'use client';

import { AlertCircle, Plus } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { FindingCard } from '@/components/finding-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Finding } from '@/lib/types';

// Mock findings matching the landing page mockup — replaced with live data in a future task
const MOCK_FINDINGS: Finding[] = [
  {
    id: 'mock-1',
    scanId: 'mock-scan-1',
    brandId: 'mock-brand-1',
    userId: 'mock-user',
    source: 'domain',
    actorId: 'doppelspotter/whoisxml-brand-alert',
    severity: 'high',
    title: 'Lookalike Domain Registered',
    description: 'yourbränd-support.com was registered 4 hours ago via Namecheap.',
    llmAnalysis:
      "This domain employs a homoglyph substitution ('ä' instead of 'a') and targets the \"support\" keyword. Combined with the recent registration date, there is a 98% probability this is being set up for a phishing campaign targeting your customers.",
    url: 'https://example.com',
    rawData: {},
    createdAt: null as unknown as import('firebase-admin/firestore').Timestamp,
  },
  {
    id: 'mock-2',
    scanId: 'mock-scan-1',
    brandId: 'mock-brand-1',
    userId: 'mock-user',
    source: 'instagram',
    actorId: 'apify/instagram-search-scraper',
    severity: 'medium',
    title: 'Fake Social Account',
    description: 'Instagram profile @official_yourbrand_deals using your logo.',
    llmAnalysis:
      'Account is scraping and reposting your official content while embedding a suspicious link tree in the bio. Intent is likely affiliate fraud or counterfeit diversion.',
    rawData: {},
    createdAt: null as unknown as import('firebase-admin/firestore').Timestamp,
  },
];

const highCount = MOCK_FINDINGS.filter((f) => f.severity === 'high').length;

export default function DashboardPage() {
  return (
    <AuthGuard>
      <Navbar />

      <main className="pt-16 min-h-screen bg-gray-50/50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

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
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            {/* Panel header */}
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Recent Threats Detected</h2>
                <p className="text-xs sm:text-sm text-gray-500">Showing mock data — connect a brand profile to run live scans</p>
              </div>
              {highCount > 0 && (
                <Badge variant="danger">
                  <AlertCircle className="w-3 h-3" />
                  {highCount} High Risk
                </Badge>
              )}
            </div>

            {/* Findings list */}
            <div className="p-4 sm:p-6 space-y-4">
              {MOCK_FINDINGS.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </div>
          </div>

          {/* Empty state hint */}
          <div className="mt-6 bg-brand-50 border border-brand-100 rounded-xl p-5 text-sm text-brand-700">
            <strong>Getting started:</strong> Add a brand profile to begin monitoring.
            DoppelSpotter will scan social media, newly-registered domains, Google Search, and app stores for potential infringements.{' '}
            <Link href="/brands/new" className="font-semibold underline hover:no-underline">
              Add your first brand →
            </Link>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
