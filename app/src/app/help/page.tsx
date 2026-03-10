'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  Shield,
  Search,
  LayoutDashboard,
  Bell,
  CheckCircle,
  XCircle,
  FileText,
  FileDown,
  Info,
  ChevronRight,
} from 'lucide-react';

const SECTIONS = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'dashboard', label: 'Dashboard & Analytics' },
  { id: 'scans', label: 'Running Scans' },
  { id: 'reviewing', label: 'Reviewing Findings' },
  { id: 'deep-search', label: 'Deep Search' },
  { id: 'exporting', label: 'Exporting Reports' },
];

const inlineLink = 'font-medium text-brand-700 transition hover:underline';

export default function HelpPage() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const isScrollingTo = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingTo.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-80px 0px -40% 0px', threshold: 0 },
    );

    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;

    isScrollingTo.current = true;
    setActiveId(id);

    const offset = 88;
    const top = element.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top, behavior: 'smooth' });

    setTimeout(() => {
      isScrollingTo.current = false;
    }, 800);
  };

  return (
    <AuthGuard>
      <Navbar />

      <main className="min-h-screen bg-gray-50 pt-16">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Help</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Everything you need to know about setting up and using DoppelSpotter. For account and password settings, see <Link href="/settings" className={inlineLink}>Settings</Link>.
            </p>
          </div>

          <div className="flex flex-col lg:flex-row gap-8">

            {/* Sticky sidebar nav */}
            <div className="w-full lg:w-56 flex-none">
              <div className="sticky top-24">
                <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-gray-400">
                  On this page
                </p>
                <nav className="flex flex-col space-y-0.5" aria-label="Help sections">
                  {SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => scrollToSection(section.id)}
                      className={cn(
                        'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition',
                        activeId === section.id
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                      )}
                    >
                      {section.label}
                    </button>
                  ))}
                </nav>
              </div>
            </div>

            {/* Main content */}
            <div className="flex-1 space-y-6">

              {/* Getting Started */}
              <section id="getting-started" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <Shield className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Getting Started: Managing Brands</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          DoppelSpotter organises your monitoring into <Link href="/brands" className={inlineLink}>Brands</Link>. A Brand represents a product, company, or entity you want to protect.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5 px-6 pb-6">
                    <div className="rounded-xl border border-gray-200 bg-gray-100 aspect-[16/7] flex items-center justify-center text-sm italic text-gray-400">
                      [Placeholder: Screenshot of the &quot;Add Brand&quot; form showing Keywords, Official Domains, Watch words, and Safe words fields]
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-1.5">
                        <p className="text-sm font-medium text-gray-900">Search Configuration</p>
                        <p className="text-sm text-gray-500">
                          <strong className="text-gray-700">Keywords</strong> are the terms we search for (e.g., your company name or product name).{' '}
                          <strong className="text-gray-700">Official Domains</strong> are your real websites — we automatically exclude these from alerts so you aren&apos;t flagged for your own content.
                          Configure both when <Link href="/brands/new" className={inlineLink}>adding a brand</Link>.
                        </p>
                      </div>
                      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-1.5">
                        <p className="text-sm font-medium text-gray-900">AI Context</p>
                        <p className="text-sm text-gray-500">
                          <strong className="text-gray-700">Watch words</strong> are suspicious terms (like &quot;crack&quot;, &quot;free&quot;, &quot;discount&quot;) that make the AI treat findings more strictly.{' '}
                          <strong className="text-gray-700">Safe words</strong> are terms that typically indicate benign content (like &quot;review&quot;, &quot;comparison&quot;).
                          Both are set in your <Link href="/brands" className={inlineLink}>brand settings</Link>.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </section>

              {/* Dashboard & Analytics */}
              <section id="dashboard" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <LayoutDashboard className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Dashboard &amp; Analytics</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          The <Link href="/dashboard" className={inlineLink}>Dashboard</Link> gives you a high-level view of your brand&apos;s threat landscape over time.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 px-6 pb-6">
                    <div className="rounded-xl border border-gray-200 bg-gray-100 aspect-[21/8] flex items-center justify-center text-sm italic text-gray-400">
                      [Placeholder: Screenshot of the Dashboard showing the metric cards and stacked bar charts]
                    </div>

                    <details className="group overflow-hidden rounded-lg border border-gray-200 bg-white">
                      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm font-medium text-gray-900 hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
                        Understanding the Metric Cards
                        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
                      </summary>
                      <div className="border-t border-gray-100 px-4 pb-4 pt-3 text-sm text-gray-500 leading-6">
                        The <Link href="/dashboard" className={inlineLink}>dashboard</Link> breaks findings into four severity categories:
                        <ul className="mt-2 space-y-1 pl-4 list-disc">
                          <li><strong className="text-red-700">High:</strong> Urgent issues that need rapid review — e.g., phishing, direct impersonation.</li>
                          <li><strong className="text-amber-600">Medium:</strong> Suspicious activity worth investigating.</li>
                          <li><strong className="text-emerald-600">Low:</strong> Lower-risk results still worth monitoring.</li>
                          <li><strong className="text-gray-600">Non-findings:</strong> Results the AI classified as benign or irrelevant.</li>
                        </ul>
                        <p className="mt-2">Clicking any metric card takes you directly to those filtered findings on the <Link href="/brands" className={inlineLink}>brand page</Link>.</p>
                      </div>
                    </details>

                    <details className="group overflow-hidden rounded-lg border border-gray-200 bg-white">
                      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm font-medium text-gray-900 hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
                        Interactive Charts
                        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
                      </summary>
                      <div className="border-t border-gray-100 px-4 pb-4 pt-3 text-sm text-gray-500 leading-6">
                        The <strong className="text-gray-700">Findings by scan type</strong> and <strong className="text-gray-700">Findings by theme</strong> charts let you see where threats are originating and what topics they cover. Clicking any segment takes you directly to those specific findings on the <Link href="/brands" className={inlineLink}>brand page</Link>.
                      </div>
                    </details>
                  </CardContent>
                </Card>
              </section>

              {/* Running Scans */}
              <section id="scans" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <Search className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Running Scans</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          Scans are the core of DoppelSpotter. Start one from any <Link href="/brands" className={inlineLink}>brand page</Link> — we search across your selected platforms and use AI to classify the results.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5 px-6 pb-6">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-gray-900">Scan Sources</p>
                        <p className="text-sm text-gray-500">Toggle specific platforms on or off per brand in <Link href="/brands" className={inlineLink}>brand settings</Link>:</p>
                        <ul className="space-y-1 text-sm text-gray-500 pl-4 list-disc">
                          <li><strong className="text-gray-700">Web Search:</strong> General Google results</li>
                          <li><strong className="text-gray-700">Social:</strong> Reddit, TikTok, YouTube, Facebook, Instagram, X</li>
                          <li><strong className="text-gray-700">Communities:</strong> Discord servers, Telegram channels</li>
                          <li><strong className="text-gray-700">Code &amp; Apps:</strong> GitHub repositories, Apple App Store, Google Play</li>
                          <li><strong className="text-gray-700">Infrastructure:</strong> Newly registered domains</li>
                        </ul>
                      </div>
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-gray-900">Search Depth</p>
                          <p className="text-sm text-gray-500">Controls how many results are pulled per source. Configure the default in <Link href="/brands" className={inlineLink}>brand settings</Link>, or override it per-run when starting a scan manually.</p>
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-gray-900">Scheduled Scans</p>
                          <p className="text-sm text-gray-500">Set scans to run automatically on a daily, weekly, or monthly basis in <Link href="/brands" className={inlineLink}>brand settings</Link> so you never miss emerging threats.</p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-100 aspect-[16/5] flex items-center justify-center text-sm italic text-gray-400">
                      [Placeholder: Screenshot of the &quot;Run Scan&quot; modal showing one-off customisation options]
                    </div>
                  </CardContent>
                </Card>
              </section>

              {/* Reviewing Findings */}
              <section id="reviewing" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <CheckCircle className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Reviewing Findings</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          When a scan completes, findings are grouped by severity on the <Link href="/brands" className={inlineLink}>brand page</Link>. DoppelSpotter learns from how you review them.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5 px-6 pb-6">
                    <div className="rounded-xl border border-gray-200 bg-gray-100 aspect-[16/7] flex items-center justify-center text-sm italic text-gray-400">
                      [Placeholder: Screenshot of a Finding Card showing the AI analysis, severity badge, Bookmark, Add Note, Address, and Ignore buttons]
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <XCircle className="h-4 w-4 flex-shrink-0 text-gray-400" />
                          <p className="text-sm font-medium text-gray-900">Ignoring False Positives</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          If the AI misclassified a benign result, click <strong className="text-gray-700">Ignore</strong>. This moves it to the &quot;Ignored&quot; tab and — more importantly — <strong className="text-gray-700">teaches the AI</strong> to automatically filter out similar results in future scans.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <CheckCircle className="h-4 w-4 flex-shrink-0 text-emerald-500" />
                          <p className="text-sm font-medium text-gray-900">Marking as Addressed</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          Once you&apos;ve taken action on a legitimate threat (like issuing a takedown notice), click <strong className="text-gray-700">Mark as Addressed</strong>. This moves it to the &quot;Addressed&quot; tab to keep your active list clean.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <Bell className="h-4 w-4 flex-shrink-0 text-brand-500" />
                          <p className="text-sm font-medium text-gray-900">Bookmarks &amp; Notes</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          Use <strong className="text-gray-700">Bookmarks</strong> to pin important findings to the top of the <Link href="/brands" className={inlineLink}>brand page</Link>. You can also <strong className="text-gray-700">Add notes</strong> to any finding to track next steps or collaborate with your team.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <Info className="h-4 w-4 flex-shrink-0 text-blue-500" />
                          <p className="text-sm font-medium text-gray-900">AI Themes</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          The AI assigns short <strong className="text-gray-700">Theme tags</strong> to findings. Use the theme filter dropdown at the top of the <Link href="/brands" className={inlineLink}>brand page</Link> to quickly narrow down results.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </section>

              {/* Deep Search */}
              <section id="deep-search" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <Search className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Deep Search</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          When enabled in <Link href="/brands" className={inlineLink}>brand settings</Link>, the AI analyses your initial scan results and automatically runs new, highly targeted follow-up searches to uncover hidden threats.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-6 pb-6">
                    <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 space-y-2">
                      <p className="text-sm font-medium text-brand-900">How it works</p>
                      <ul className="space-y-1.5 text-sm text-brand-800 leading-6 pl-4 list-disc">
                        <li>After the initial scan completes, the AI reviews the intent and context of all results.</li>
                        <li>It then synthesizes and launches new searches targeting distinct abuse vectors it identified.</li>
                        <li>Use the <strong>Deep search breadth</strong> setting in <Link href="/brands" className="font-medium text-brand-700 transition hover:underline">brand settings</Link> (1–5) to control how many follow-up searches can run per scan.</li>
                        <li>Deep searches are clearly labelled in the progress UI while a scan is running.</li>
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              </section>

              {/* Exporting */}
              <section id="exporting" className="scroll-mt-24">
                <Card>
                  <CardHeader className="px-6 py-5">
                    <div className="flex items-start gap-4">
                      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                        <FileDown className="h-5 w-5 text-brand-600" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-gray-900">Exporting Reports</h2>
                        <p className="mt-1 text-sm leading-6 text-gray-600">
                          Share your findings with legal teams, stakeholders, or clients using the Export button on any completed scan on your <Link href="/brands" className={inlineLink}>brand page</Link>.
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5 px-6 pb-6">
                    <div className="rounded-xl border border-gray-200 bg-gray-100 aspect-[16/5] flex items-center justify-center text-sm italic text-gray-400">
                      [Placeholder: Screenshot of the scan header showing the &quot;Export&quot; button dropdown]
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 flex-shrink-0 text-gray-400" />
                          <p className="text-sm font-medium text-gray-900">PDF Reports</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          A clean, branded document containing the AI&apos;s executive summary and all actionable threats, grouped by severity. Ideal for sharing with management or legal teams.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex items-center gap-2">
                          <FileDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                          <p className="text-sm font-medium text-gray-900">CSV Exports</p>
                        </div>
                        <p className="text-sm text-gray-500">
                          Raw data for every finding in the scan, including URLs, AI analysis, notes, and review-state flags. Ideal for tracking in spreadsheets.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </section>

            </div>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
