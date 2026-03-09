'use client';

import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Card, CardContent } from '@/components/ui/card';
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

export default function HelpPage() {
  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      const offset = 80; // Account for sticky navbar
      const elementPosition = element.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - offset;
      
      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
    }
  };

  return (
    <AuthGuard>
      <Navbar />
      
      <main className="min-h-screen bg-gray-50 pt-16">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Help Center</h1>
            <p className="mt-2 text-lg text-gray-600">
              Everything you need to know about setting up and using DoppelSpotter to protect your brand online.
            </p>
          </div>

          <div className="flex flex-col lg:flex-row gap-8">
            {/* Sidebar Navigation */}
            <div className="w-full lg:w-64 flex-none">
              <div className="sticky top-24">
                <nav className="flex flex-col space-y-1" aria-label="Sidebar">
                  {SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      className="flex items-center text-left px-3 py-2 text-sm font-medium rounded-lg text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                    >
                      {section.label}
                    </button>
                  ))}
                </nav>
              </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 space-y-12">
              
              {/* Getting Started */}
              <section id="getting-started" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <Shield className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Getting Started: Managing Brands</h2>
                </div>
                <p className="text-gray-600">
                  DoppelSpotter organises your monitoring into <strong>Brands</strong>. A Brand represents a product, company, or entity you want to protect.
                </p>
                
                <div className="bg-gray-100 rounded-xl border border-gray-200 aspect-[16/9] flex items-center justify-center text-gray-400 text-sm italic">
                  [Placeholder: Screenshot of the &quot;Add Brand&quot; form showing Keywords, Official domains, Watch words, and Safe words fields]
                </div>
                
                <div className="grid gap-4 md:grid-cols-2 mt-4">
                  <Card>
                    <CardContent className="p-5 space-y-2">
                      <h3 className="font-semibold text-gray-900">Search Configuration</h3>
                      <p className="text-sm text-gray-600">
                        <strong>Keywords</strong> are the terms we search for (e.g., your company name or product name). 
                        <strong> Official Domains</strong> are your real websites—we automatically exclude these from alerts so you aren&apos;t flagged for your own content.
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-5 space-y-2">
                      <h3 className="font-semibold text-gray-900">AI Context</h3>
                      <p className="text-sm text-gray-600">
                        <strong>Watch words</strong> are suspicious terms (like &quot;crack&quot;, &quot;free&quot;, &quot;discount&quot;) that make the AI treat findings more strictly.
                        <strong> Safe words</strong> are terms that usually indicate benign content (like &quot;review&quot;, &quot;comparison&quot;).
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Dashboard & Analytics */}
              <section id="dashboard" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <LayoutDashboard className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Dashboard & Analytics</h2>
                </div>
                <p className="text-gray-600">
                  Your dashboard gives you a high-level view of your brand&apos;s threat landscape over time.
                </p>

                <div className="bg-gray-100 rounded-xl border border-gray-200 aspect-[21/9] flex items-center justify-center text-gray-400 text-sm italic">
                  [Placeholder: Screenshot of the Dashboard showing the metric cards and stacked bar charts]
                </div>

                <div className="space-y-4">
                  <details className="group border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <summary className="flex cursor-pointer items-center justify-between px-5 py-4 font-medium text-gray-900 hover:bg-gray-50">
                      Understanding the Metric Cards
                      <ChevronRight className="h-5 w-5 text-gray-400 transition-transform group-open:rotate-90" />
                    </summary>
                    <div className="px-5 pb-5 text-sm text-gray-600 border-t border-gray-100 pt-4">
                      The dashboard breaks findings down into four categories:
                      <ul className="mt-2 list-disc pl-5 space-y-1">
                        <li><strong className="text-red-700">High severity:</strong> Urgent issues that need rapid review (e.g., phishing, direct impersonation).</li>
                        <li><strong className="text-amber-600">Medium severity:</strong> Suspicious activity worth investigating.</li>
                        <li><strong className="text-emerald-600">Low severity:</strong> Lower-risk results still worth monitoring (e.g., mentions).</li>
                        <li><strong className="text-gray-600">Non-findings:</strong> Results the AI classified as benign or irrelevant.</li>
                      </ul>
                    </div>
                  </details>

                  <details className="group border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <summary className="flex cursor-pointer items-center justify-between px-5 py-4 font-medium text-gray-900 hover:bg-gray-50">
                      Interactive Charts
                      <ChevronRight className="h-5 w-5 text-gray-400 transition-transform group-open:rotate-90" />
                    </summary>
                    <div className="px-5 pb-5 text-sm text-gray-600 border-t border-gray-100 pt-4">
                      The <strong>Findings by scan type</strong> and <strong>Findings by theme</strong> charts let you see where threats are originating and what topics they cover. Clicking on any segment of these charts will take you directly to those specific findings on the brand page.
                    </div>
                  </details>
                </div>
              </section>

              {/* Running Scans */}
              <section id="scans" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <Search className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Running Scans</h2>
                </div>
                <p className="text-gray-600">
                  Scans are the core of DoppelSpotter. When a scan runs, we search across your selected platforms and use AI to classify the results.
                </p>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="font-semibold text-gray-900">Scan Sources</h3>
                    <p className="text-sm text-gray-600">
                      You can toggle specific platforms on or off for your brand:
                    </p>
                    <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-4">
                      <li><strong>Web Search:</strong> General Google results</li>
                      <li><strong>Social Media:</strong> Reddit, TikTok, YouTube, Facebook, Instagram, X (Twitter)</li>
                      <li><strong>Communities:</strong> Discord servers, Telegram channels</li>
                      <li><strong>Code & Apps:</strong> GitHub repositories, Apple App Store, Google Play</li>
                      <li><strong>Infrastructure:</strong> Newly registered domains</li>
                    </ul>
                  </div>

                  <div className="space-y-3">
                    <h3 className="font-semibold text-gray-900">Search Settings & Scheduling</h3>
                    <p className="text-sm text-gray-600">
                      <strong>Search Depth:</strong> Controls how many results we pull per source. A higher depth retrieves more pages but takes longer to process.
                    </p>
                    <p className="text-sm text-gray-600">
                      <strong>Scheduled Scans:</strong> You can set scans to run automatically on a daily, weekly, or monthly basis so you never miss emerging threats.
                    </p>
                  </div>
                </div>
                
                <div className="bg-gray-100 rounded-xl border border-gray-200 aspect-[16/5] flex items-center justify-center text-gray-400 text-sm italic mt-4">
                  [Placeholder: Screenshot of the &quot;Run Scan&quot; modal showing one-off customisation options]
                </div>
              </section>

              {/* Reviewing Findings */}
              <section id="reviewing" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <CheckCircle className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Reviewing Findings</h2>
                </div>
                <p className="text-gray-600">
                  When a scan completes, findings are grouped by severity. DoppelSpotter learns from how you review these findings.
                </p>

                <div className="bg-gray-100 rounded-xl border border-gray-200 aspect-[16/9] flex items-center justify-center text-gray-400 text-sm italic">
                  [Placeholder: Screenshot of a Finding Card showing the AI analysis, severity badge, Bookmark, Add Note, Address, and Ignore buttons]
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <XCircle className="h-5 w-5 text-gray-400" />
                        <h3 className="font-semibold text-gray-900">Ignoring False Positives</h3>
                      </div>
                      <p className="text-sm text-gray-600">
                        If the AI misclassified a benign result as a threat, click <strong>Ignore</strong>. This moves it to the &quot;Ignored&quot; tab. More importantly, <strong>the AI learns from this</strong> and will automatically filter out similar false positives in future scans.
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-emerald-500" />
                        <h3 className="font-semibold text-gray-900">Marking as Addressed</h3>
                      </div>
                      <p className="text-sm text-gray-600">
                        Once you have taken action on a legitimate threat (like issuing a takedown notice), click <strong>Mark as Addressed</strong>. This moves it to the &quot;Addressed&quot; tab to keep your active findings list clean.
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <Bell className="h-5 w-5 text-brand-500" />
                        <h3 className="font-semibold text-gray-900">Bookmarks & Notes</h3>
                      </div>
                      <p className="text-sm text-gray-600">
                        Use <strong>Bookmarks</strong> to pin important findings to the top of your brand page. You can also <strong>Add notes</strong> to any finding to collaborate with your team or track next steps.
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <Info className="h-5 w-5 text-blue-500" />
                        <h3 className="font-semibold text-gray-900">AI Themes</h3>
                      </div>
                      <p className="text-sm text-gray-600">
                        The AI assigns short <strong>Theme tags</strong> (like &quot;Phishing&quot; or &quot;Counterfeit&quot;) to findings. You can use the dropdown filters at the top of the brand page to quickly narrow down results by these themes.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </section>

              {/* Deep Search */}
              <section id="deep-search" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <Search className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Deep Search</h2>
                </div>
                
                <div className="bg-brand-50 border border-brand-100 rounded-lg p-5">
                  <h3 className="font-semibold text-brand-900 mb-2">AI-Powered Follow-ups</h3>
                  <p className="text-sm text-brand-800 mb-4">
                    When <strong>Deep Search</strong> is enabled, the AI analyses the intent and context of your initial scan results. It then automatically synthesizes and runs <em>new, highly targeted searches</em> to uncover hidden threats.
                  </p>
                  <ul className="text-sm text-brand-800 space-y-2 list-disc pl-4">
                    <li>It acts as an autonomous investigator, looking for distinct abuse vectors.</li>
                    <li>You can limit how many Deep Searches run per scan using the <strong>Deep search breadth</strong> setting (between 1 and 5).</li>
                    <li>Deep Searches are clearly labelled in the progress UI while a scan is running.</li>
                  </ul>
                </div>
              </section>

              {/* Exporting */}
              <section id="exporting" className="scroll-mt-24 space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-200 pb-2">
                  <FileDown className="h-6 w-6 text-brand-600" />
                  <h2 className="text-2xl font-semibold text-gray-900">Exporting Reports</h2>
                </div>
                <p className="text-gray-600">
                  DoppelSpotter makes it easy to share your findings with legal teams, stakeholders, or clients.
                </p>

                <div className="bg-gray-100 rounded-xl border border-gray-200 aspect-[16/5] flex items-center justify-center text-gray-400 text-sm italic">
                  [Placeholder: Screenshot of the scan header showing the &quot;Export&quot; button dropdown]
                </div>

                <div className="flex flex-col sm:flex-row gap-4 mt-4">
                  <div className="flex-1 border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="h-5 w-5 text-gray-500" />
                      <h3 className="font-semibold text-gray-900">PDF Reports</h3>
                    </div>
                    <p className="text-sm text-gray-600">
                      Generates a clean, branded document containing the AI&apos;s executive summary and all actionable threats. Perfect for sharing with management.
                    </p>
                  </div>
                  <div className="flex-1 border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <FileDown className="h-5 w-5 text-gray-500" />
                      <h3 className="font-semibold text-gray-900">CSV Exports</h3>
                    </div>
                    <p className="text-sm text-gray-600">
                      Downloads raw data for every finding in the scan, including URLs, AI analysis, and your custom notes. Ideal for tracking in spreadsheets.
                    </p>
                  </div>
                </div>
              </section>

            </div>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}