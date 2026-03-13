'use client';

import { type ElementType, type ReactNode, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { usePageTitle } from '@/lib/use-page-title';
import Link from 'next/link';
import {
  CheckCircle2,
  ChevronRight,
  Compass,
  FileDown,
  Filter,
  LayoutDashboard,
  PlayCircle,
  Settings2,
  Shield,
  UserCog,
} from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { id: 'overview', label: 'Overview & Navigation' },
  { id: 'brands', label: 'Brands & Setup' },
  { id: 'scan-settings', label: 'Scan Settings' },
  { id: 'running-scans', label: 'Running Scans' },
  { id: 'reviewing-findings', label: 'Reviewing Findings' },
  { id: 'search-and-bulk', label: 'Search, Filters & Bulk Actions' },
  { id: 'dashboard', label: 'Dashboard & Analytics' },
  { id: 'reports', label: 'Reports & Emails' },
  { id: 'account', label: 'Account & Data Management' },
];

const inlineLink = 'font-medium text-brand-700 transition hover:underline';

function DocImage({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <Image src={src} alt={alt} width={1400} height={600} className="w-full h-auto" unoptimized />
    </div>
  );
}

function HelpAccordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm font-medium text-gray-900 hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-gray-100 px-4 pb-4 pt-3 text-sm leading-6 text-gray-500">
        {children}
      </div>
    </details>
  );
}

function HelpSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: ElementType;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Card>
        <CardHeader className="px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
              <Icon className="h-5 w-5 text-brand-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
              <p className="mt-1 text-sm leading-6 text-gray-600">{description}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 px-6 pb-6">{children}</CardContent>
      </Card>
    </section>
  );
}

export default function HelpPage() {
  usePageTitle('Help');
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const isScrollingTo = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingTo.current) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: '-80px 0px -40% 0px', threshold: 0 },
    );

    for (const { id } of SECTIONS) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
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
            <p className="mt-0.5 text-sm text-gray-500">
              A practical guide to setting up brands, tuning scans, reviewing findings, exporting reports,
              and managing your account. Use the sidebar to jump straight to the part of the workflow you
              need.
            </p>
          </div>

          <div className="flex flex-col gap-8 lg:flex-row">
            <div className="w-full flex-none lg:w-64">
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

            <div className="flex-1 space-y-6">
              <HelpSection
                id="overview"
                icon={Compass}
                title="Overview & Navigation"
                description={(
                  <>
                    DoppelSpotter is organised around a few core surfaces: the{' '}
                    <Link href="/dashboard" className={inlineLink}>Dashboard</Link>, your{' '}
                    <Link href="/brands" className={inlineLink}>Brands</Link>, the in-app{' '}
                    Help page, and your account menu.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/1-overview-and-navigation.png"
                  alt="Annotated screenshot of the main navigation showing Dashboard, Brands, Help, and the user menu"
                />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Dashboard</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Use the dashboard for the big-picture view: severity totals, scan-type breakdowns,
                      theme breakdowns, and trend charts over time.
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Brand pages</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Most day-to-day work happens on a brand page: running scans, checking progress,
                      searching results, reviewing findings, exporting reports, and opening Brand Settings.
                    </p>
                  </div>
                </div>

                <HelpAccordion title="Recommended first-time workflow" defaultOpen>
                  <ol className="list-decimal space-y-2 pl-5">
                    <li>Create a brand from <Link href="/brands/new" className={inlineLink}>Add Brand</Link>.</li>
                    <li>Start with a broader lookback period to build an initial baseline of findings.</li>
                    <li>Run a scan using your saved defaults or a one-off custom scan.</li>
                    <li>Review the completed scan by severity, then tidy the results using reclassify, ignore, addressed, bookmark, and note actions.</li>
                    <li>Use the dashboard and exports once you have a few completed scans to compare trends over time.</li>
                  </ol>
                </HelpAccordion>

                <HelpAccordion title="Where to go for common tasks">
                  <ul className="list-disc space-y-2 pl-5">
                    <li><strong className="text-gray-700">Add or edit a monitored brand:</strong> <Link href="/brands" className={inlineLink}>Brands</Link>.</li>
                    <li><strong className="text-gray-700">Run a scan or review results:</strong> open a brand page from <Link href="/brands" className={inlineLink}>Brands</Link>.</li>
                    <li><strong className="text-gray-700">Compare trends across scans:</strong> <Link href="/dashboard" className={inlineLink}>Dashboard</Link>.</li>
                    <li><strong className="text-gray-700">Change your password or account preferences:</strong> <Link href="/settings" className={inlineLink}>Settings</Link>.</li>
                  </ul>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="brands"
                icon={Shield}
                title="Brands & Setup"
                description={(
                  <>
                    A brand is the unit DoppelSpotter monitors. Each brand has its own protected keywords, owned
                    domains, scan defaults, source toggles, AI settings, and scan history.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/2-brands-and-setup.png"
                  alt="Screenshot of the Brand Settings page showing brand name, protected keywords, official domains, watch words, safe words, scan settings, and scan types"
                />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Brand name</p>
                    <p className="mt-1 text-sm text-gray-500">
                      The primary label for the entity you want to protect. This is what you will see in the
                      dashboard, brand list, and exports.
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Protected keywords</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Search terms associated with the brand, such as trademarks, product names, or common
                      variants. These drive what the scans look for, with a maximum of 10 per brand.
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Official domains</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Domains you own. These help DoppelSpotter avoid treating your legitimate sites as
                      threats and are validated when you save the brand.
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">Watch words and safe words</p>
                    <p className="mt-1 text-sm text-gray-500">
                      These do not create additional searches on their own. Instead, they steer the AI to be
                      more cautious around suspicious language and more forgiving around obviously benign
                      language.
                    </p>
                  </div>
                </div>

                <HelpAccordion title="When to edit a brand instead of using a custom scan" defaultOpen>
                  <p>
                    Update <Link href="/brands" className={inlineLink}>Brand Settings</Link> when you want to
                    change the saved defaults for future scans, such as source toggles, schedules, deep search,
                    or analysis rules. Use a custom scan when you only want a one-off override for a single run.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Brand list page">
                  <p>
                    The <Link href="/brands" className={inlineLink}>Brands</Link> page shows every monitored
                    brand with a quick summary: total scans, total findings, total non-findings, the last scan
                    time, whether a scan is currently in progress, and the next scheduled run if scheduling is
                    enabled.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="scan-settings"
                icon={Settings2}
                title="Scan Settings"
                description={(
                  <>
                    Each brand stores default scan behavior, including lookback period, search depth, deep
                    search, source selection, scheduled scans, summary emails, and AI severity definitions.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/3-scan-settings.gif"
                  alt="Animated walkthrough of the scan settings area showing lookback period, search depth, deep search, scheduled scans, and analysis settings"
                />

                <HelpAccordion title="Lookback period" defaultOpen>
                  <p>
                    Choose how far back scans should look for results. Available options are <strong className="text-gray-700">1 year</strong>,{' '}
                    <strong className="text-gray-700">1 month</strong>, <strong className="text-gray-700">1 week</strong>, and{' '}
                    <strong className="text-gray-700">Since last scan</strong>.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Use a broader lookback early on to build an initial baseline.</li>
                    <li>After a few scans, switching to <strong className="text-gray-700">Since last scan</strong> usually gives cleaner, more recent results.</li>
                    <li>DoppelSpotter may suggest this switch automatically after several scans.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Search depth">
                  <p>
                    Search depth controls how much data DoppelSpotter pulls per source. Higher depth usually
                    means better coverage, but slower scans.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Google-backed scan types use this as search-result depth.</li>
                    <li>Domain registrations use it as result volume.</li>
                    <li>GitHub repos and X use it as item volume.</li>
                    <li>Discord servers map it to a higher spend cap per run.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Scan types">
                  <p>
                    You can turn individual scan types on or off per brand. The current app supports Web search,
                    Reddit, TikTok, YouTube, Facebook, Instagram, Telegram channels, Apple App Store, Google
                    Play, Discord servers, GitHub repos, X, and recent domain registrations.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Deep search">
                  <p>
                    Deep search lets AI request follow-up searches after it reviews the initial results. You can
                    control both whether it is allowed and how many follow-up searches it may run.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Deep search is available on Google-backed scan types plus the first-class Reddit, TikTok, and X scans.</li>
                    <li>It is not used for Discord servers, GitHub repos, or domain registrations.</li>
                    <li>The <strong className="text-gray-700">Deep search breadth</strong> slider caps how many follow-up searches can run in a scan.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Scheduled scans">
                  <p>
                    Scheduled scans can run <strong className="text-gray-700">daily</strong>,{' '}
                    <strong className="text-gray-700">weekly</strong>,{' '}
                    <strong className="text-gray-700">fortnightly</strong>, or{' '}
                    <strong className="text-gray-700">monthly</strong>. The selected start date, time, and
                    timezone anchor the schedule, and manual scans are still available whenever you need them.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Scan summary emails">
                  <p>
                    If enabled, DoppelSpotter sends a completed-scan summary to your account email address.
                    This is configured per brand, so you can enable it for some brands and disable it for
                    others.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Analysis settings">
                  <p>
                    The analysis settings section lets you customise the definitions DoppelSpotter uses for{' '}
                    <strong className="text-gray-700">high</strong>, <strong className="text-gray-700">medium</strong>, and{' '}
                    <strong className="text-gray-700">low</strong> severity. Use this when you want the AI to
                    follow brand-specific risk thresholds.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="running-scans"
                icon={PlayCircle}
                title="Running Scans"
                description={(
                  <>
                    Start scans from a brand page, either with your saved defaults or with one-off custom
                    settings for that run only.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/4-running-scans.gif"
                  alt="Animated demo of opening the Run scan menu, choosing between scan defaults and a custom scan, then showing the live progress panel"
                />

                <HelpAccordion title="Scan defaults vs custom scan" defaultOpen>
                  <p>
                    The <strong className="text-gray-700">Run scan</strong> menu has two paths:
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Scan defaults:</strong> uses the saved settings from Brand Settings.</li>
                    <li><strong className="text-gray-700">Custom scan:</strong> lets you override lookback period, search depth, deep search, and scan types for this run only.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Live scan progress">
                  <p>
                    While a scan is running, the top of the Scans tab shows a live progress card. It groups
                    progress by source, shows source-specific status text, displays a progress bar, and can
                    reveal early findings before the scan fully completes.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Use the source icons to switch between Web search, domain registrations, Discord, GitHub, X, and other enabled scan types.</li>
                    <li>If deep search runs, the progress labels switch to related-query investigation states.</li>
                    <li>Duplicate results may be skipped automatically if they repeat historical or same-scan findings.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Cancelling a scan">
                  <p>
                    You can cancel a scan while it is in progress. Once cancelled, the live progress card closes
                    and the scan history refreshes. Deleting scans or clearing history is disabled while another
                    scan is active.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Scheduled scan visibility">
                  <p>
                    If a brand has scheduling enabled, the brand page shows a banner above the findings area with
                    the schedule frequency and the next due run time in the chosen timezone.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="reviewing-findings"
                icon={CheckCircle2}
                title="Reviewing Findings"
                description={(
                  <>
                    Completed scans appear as expandable result sets on the brand page, grouped by severity with
                    AI summaries and per-finding actions.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/5-reviewing-findings.gif"
                  alt="Animated walkthrough of an expanded completed scan showing the AI summary, severity groups, a non-findings section, and a finding card with action buttons"
                />

                <HelpAccordion title="What a completed scan shows" defaultOpen>
                  <p>
                    Each scan row shows the scan date, which scan types were used, counts by severity, and any
                    non-findings, ignored items, addressed items, or skipped duplicates. Expand the row to review
                    the findings and the scan-level AI summary.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Severity groups and non-findings">
                  <p>
                    Actionable findings are grouped into <strong className="text-red-700">High</strong>,{' '}
                    <strong className="text-amber-600">Medium</strong>, and <strong className="text-emerald-600">Low</strong>.
                    Results the AI believes are benign or irrelevant are shown under{' '}
                    <strong className="text-gray-700">Non-findings</strong>.
                  </p>
                  <p className="mt-2">
                    Non-findings can still be useful to review. You can bookmark them, add notes, or reclassify
                    them into any severity if the AI got the judgment wrong.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Finding card actions">
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Reclassify:</strong> move a finding into High, Medium, Low, or Non-finding.</li>
                    <li><strong className="text-gray-700">Ignore:</strong> dismiss a real finding you do not want treated as actionable.</li>
                    <li><strong className="text-gray-700">Mark as addressed:</strong> move a real finding out of the active list once you have dealt with it.</li>
                    <li><strong className="text-gray-700">Bookmark:</strong> pin a finding for follow-up. This is available for both real findings and non-findings.</li>
                    <li><strong className="text-gray-700">Add note:</strong> store your own follow-up context directly on the finding card.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Ignored vs addressed vs bookmarked">
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Ignored</strong> is for real findings you have dismissed. Ignored items live in the Ignored tab and in per-scan Ignored sections.</li>
                    <li><strong className="text-gray-700">Addressed</strong> is for real findings you acted on and want to keep out of the active queue.</li>
                    <li><strong className="text-gray-700">Bookmarks</strong> are follow-up markers only. They do not change the finding&apos;s severity or review state.</li>
                    <li>Ignored and addressed behavior is applied across matching findings for the same URL, while bookmarks and notes stay on the individual finding record.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Themes and AI analysis">
                  <p>
                    Each finding can include a short AI-assigned <strong className="text-gray-700">theme</strong>.
                    Themes help you spot recurring abuse patterns and can be used in both filters and dashboard
                    charts.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Domain registration warning">
                  <p>
                    Opening a domain-registration finding may show a warning first, because some suspicious
                    domains can host inappropriate content. You can keep the warning on, or turn it off in{' '}
                    <Link href="/settings" className={inlineLink}>Settings</Link>.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="search-and-bulk"
                icon={Filter}
                title="Search, Filters & Bulk Actions"
                description={(
                  <>
                    The brand page supports cross-scan search, severity/source/theme filters, dedicated tabs for
                    different review states, and bulk actions for faster cleanup.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/6-search-filters-bulk.gif"
                  alt="Animated demo of typing into findings search, applying theme, severity, and source filters, switching tabs, selecting findings, and using the bulk action tray"
                />

                <HelpAccordion title="Findings search" defaultOpen>
                  <p>
                    Use the search box at the top of the findings area to search finding titles, URLs, and AI
                    analyses across scans.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Search starts once you type at least <strong className="text-gray-700">2 characters</strong>.</li>
                    <li>Results can include findings from the Scans, Bookmarks, Addressed, Ignored, and Non-findings views.</li>
                    <li>You can combine search with severity, scan-type, and theme filters.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Tabs">
                  <p>
                    The main findings area is split into four tabs:
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Scans:</strong> the normal per-scan review view.</li>
                    <li><strong className="text-gray-700">Bookmarks:</strong> cross-scan follow-up items, including bookmarked non-findings.</li>
                    <li><strong className="text-gray-700">Addressed:</strong> real findings you have already handled.</li>
                    <li><strong className="text-gray-700">Ignored:</strong> real findings you dismissed.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Filters">
                  <p>
                    The filter row lets you narrow results by <strong className="text-gray-700">theme</strong>,{' '}
                    <strong className="text-gray-700">severity</strong>, and{' '}
                    <strong className="text-gray-700">scan type</strong>. Use <strong className="text-gray-700">Reset</strong> to
                    clear everything at once.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Bulk actions">
                  <p>
                    Selecting one or more findings opens a bulk action tray at the bottom of the screen. Bulk
                    actions only apply to compatible findings, so some buttons may be disabled depending on what
                    you selected.
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Apply actions: Reclassify, Ignore, Mark as addressed, Bookmark.</li>
                    <li>Reverse actions: Un-ignore, Mark as not addressed, Un-bookmark.</li>
                  </ul>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="dashboard"
                icon={LayoutDashboard}
                title="Dashboard & Analytics"
                description={(
                  <>
                    The dashboard gives you a brand-scoped analytics view of completed scans, including totals,
                    breakdown charts, and trend charts over time.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/7-dashboard.gif"
                  alt="Animated walkthrough of the dashboard showing the brand selector, scan scope selector, metric cards, stacked charts, and trend charts"
                />

                <HelpAccordion title="Brand and scan scope" defaultOpen>
                  <p>
                    Choose a focused brand at the top of the dashboard, then decide whether you want to look at{' '}
                    <strong className="text-gray-700">All scans</strong> or a single completed scan. Your selected
                    brand is saved so it comes back the next time you visit.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Metric cards">
                  <p>
                    The four metric cards show totals for High severity, Medium severity, Low severity, and
                    Non-findings. Clicking a card takes you to the relevant filtered results on the brand page.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Breakdown charts">
                  <p>
                    The stacked bar charts answer two different questions:
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Findings by scan type:</strong> where results are being found.</li>
                    <li><strong className="text-gray-700">Findings by theme:</strong> what recurring topics or abuse patterns are appearing.</li>
                  </ul>
                  <p className="mt-2">
                    Clicking a chart segment opens the matching slice of results on the brand page.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Trend charts">
                  <p>
                    When the dashboard is set to <strong className="text-gray-700">All scans</strong>, two extra
                    line charts appear to show cumulative trends over time by scan type and by theme. You can
                    choose which series to display.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="reports"
                icon={FileDown}
                title="Reports & Emails"
                description={(
                  <>
                    DoppelSpotter can export completed scans and optionally email a summary when a scan finishes.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/8-reports-and-emails.png"
                  alt="Screenshot of a completed scan row showing the CSV and PDF export buttons, plus a scan summary email"
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">CSV export</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Exports every finding in the scan for spreadsheet-style review, including non-findings,
                      notes, and review-state flags.
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-medium text-gray-900">PDF export</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Produces a branded report with the scan summary and actionable findings grouped by
                      severity. It is designed for sharing with stakeholders, legal teams, or clients.
                    </p>
                  </div>
                </div>

                <HelpAccordion title="What gets exported" defaultOpen>
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">CSV:</strong> full scan output for detailed review and spreadsheet analysis.</li>
                    <li><strong className="text-gray-700">PDF:</strong> a presentation-friendly report focused on actionable findings and the scan-level AI summary.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Scan summary emails">
                  <p>
                    If the brand&apos;s <strong className="text-gray-700">Send scan summary emails</strong> setting is
                    on, DoppelSpotter sends a summary email to your account email address after the scan is
                    fully completed.
                  </p>
                </HelpAccordion>
              </HelpSection>

              <HelpSection
                id="account"
                icon={UserCog}
                title="Account & Data Management"
                description={(
                  <>
                    Use the user menu and Settings page for account tasks, and use the brand page or Brand
                    Settings for cleanup actions like deleting scans or brands.
                  </>
                )}
              >
                <DocImage
                  src="/docs-images/9-account-management.gif"
                  alt="Animated walkthrough of the user menu, Settings page, and destructive actions including clear history, delete scan, delete brand, and delete account"
                />

                <HelpAccordion title="Signing in, verification, and password recovery" defaultOpen>
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li>New signups are invite-only.</li>
                    <li>New accounts must verify their email before they can sign in.</li>
                    <li>If you forget your password, use the <strong className="text-gray-700">Forgotten your password?</strong> link on the login screen to request a reset email.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Settings page">
                  <p>
                    Open <Link href="/settings" className={inlineLink}>Settings</Link> from the user menu to:
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    <li>Change your password.</li>
                    <li>Turn the domain-registration visit warning back on or off.</li>
                    <li>Delete your entire account and all associated brands, scans, findings, and preferences.</li>
                  </ul>
                </HelpAccordion>

                <HelpAccordion title="Brand cleanup actions">
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li><strong className="text-gray-700">Delete scan:</strong> removes one scan and its findings from the brand page.</li>
                    <li><strong className="text-gray-700">Clear history:</strong> removes all scan history and results for the current brand.</li>
                    <li><strong className="text-gray-700">Delete brand:</strong> removes the brand and all of its scan history permanently from Brand Settings.</li>
                  </ul>
                  <p className="mt-2">
                    These actions are destructive and cannot be undone. Some are disabled while a scan is
                    running or while brand history is already being deleted.
                  </p>
                </HelpAccordion>

                <HelpAccordion title="Signing out">
                  <p>
                    Use the user menu in the top-right corner of the navbar to sign out at any time.
                  </p>
                </HelpAccordion>
              </HelpSection>
            </div>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
