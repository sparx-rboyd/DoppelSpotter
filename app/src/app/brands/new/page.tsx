'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { BrandAnalysisSettingsFields } from '@/components/brand-analysis-settings-fields';
import { BrandScanScheduleFields } from '@/components/brand-scan-schedule-fields';
import { BrandScanSourceFields } from '@/components/brand-scan-source-fields';
import { BrandScanTuningFields } from '@/components/brand-scan-tuning-fields';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagInput } from '@/components/ui/tag-input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/tooltip';
import {
  DEFAULT_SEARCH_RESULT_PAGES,
  DEFAULT_ALLOW_AI_DEEP_SEARCHES,
  DEFAULT_BRAND_SCAN_SOURCES,
  DEFAULT_MAX_AI_DEEP_SEARCHES,
  hasEnabledBrandScanSource,
} from '@/lib/brands';
import { isValidBrandAnalysisSeverityDefinitions } from '@/lib/analysis-severity';
import {
  DEFAULT_SCAN_SCHEDULE_FREQUENCY,
  getBrowserTimeZone,
  getDefaultScheduleStartInput,
  isScheduleStartInPast,
} from '@/lib/scan-schedules';
import type { BrandAnalysisSeverityDefinitions, BrandScanScheduleInput } from '@/lib/types';

export default function NewBrandPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState('');
  const [domainError, setDomainError] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [watchWordInput, setWatchWordInput] = useState('');
  const [watchWords, setWatchWords] = useState<string[]>([]);
  const [safeWordInput, setSafeWordInput] = useState('');
  const [safeWords, setSafeWords] = useState<string[]>([]);
  const [sendScanSummaryEmails, setSendScanSummaryEmails] = useState(true);
  const [searchResultPages, setSearchResultPages] = useState(DEFAULT_SEARCH_RESULT_PAGES);
  const [allowAiDeepSearches, setAllowAiDeepSearches] = useState(DEFAULT_ALLOW_AI_DEEP_SEARCHES);
  const [maxAiDeepSearches, setMaxAiDeepSearches] = useState(DEFAULT_MAX_AI_DEEP_SEARCHES);
  const [scanSources, setScanSources] = useState(DEFAULT_BRAND_SCAN_SOURCES);
  const [analysisSeverityDefinitions, setAnalysisSeverityDefinitions] = useState<BrandAnalysisSeverityDefinitions>({});
  const [scanSchedule, setScanSchedule] = useState<BrandScanScheduleInput>(() => {
    const timeZone = getBrowserTimeZone();
    const defaultStart = getDefaultScheduleStartInput(timeZone);

    return {
      enabled: false,
      frequency: DEFAULT_SCAN_SCHEDULE_FREQUENCY,
      timeZone,
      startDate: defaultStart.startDate,
      startTime: defaultStart.startTime,
    };
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function addKeyword() {
    const trimmed = keywordInput.trim().toLowerCase();
    if (trimmed && !keywords.includes(trimmed)) {
      setKeywords([...keywords, trimmed]);
    }
    setKeywordInput('');
  }

  function removeKeyword(kw: string) {
    setKeywords(keywords.filter((k) => k !== kw));
  }

  function addDomain() {
    const normalized = domainInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '');

    if (!normalized) {
      setDomainInput('');
      setDomainError('');
      return;
    }

    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(normalized)) {
      setDomainError('Please enter a valid domain (e.g. example.com)');
      return;
    }

    setDomainError('');
    if (!domains.includes(normalized)) {
      setDomains([...domains, normalized]);
    }
    setDomainInput('');
  }

  function removeDomain(d: string) {
    setDomains(domains.filter((x) => x !== d));
  }

  function addWatchWord() {
    const trimmed = watchWordInput.trim().toLowerCase();
    if (trimmed && !watchWords.includes(trimmed)) {
      setWatchWords([...watchWords, trimmed]);
    }
    setWatchWordInput('');
  }

  function removeWatchWord(w: string) {
    setWatchWords(watchWords.filter((x) => x !== w));
  }

  function addSafeWord() {
    const trimmed = safeWordInput.trim().toLowerCase();
    if (trimmed && !safeWords.includes(trimmed)) {
      setSafeWords([...safeWords, trimmed]);
    }
    setSafeWordInput('');
  }

  function removeSafeWord(w: string) {
    setSafeWords(safeWords.filter((x) => x !== w));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!hasEnabledBrandScanSource(scanSources)) {
      setError('At least one scan source must be enabled');
      return;
    }
    if (!isValidBrandAnalysisSeverityDefinitions(analysisSeverityDefinitions)) {
      setError('Custom analysis severity definitions must be non-empty and no longer than 1500 characters');
      return;
    }
    if (scanSchedule.enabled && isScheduleStartInPast(scanSchedule)) {
      setError('Scheduled scan start date and time must be in the future');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/brands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: name.trim(),
          keywords,
          officialDomains: domains,
          searchResultPages,
          sendScanSummaryEmails,
          allowAiDeepSearches,
          maxAiDeepSearches,
          scanSources,
          analysisSeverityDefinitions,
          watchWords,
          safeWords,
          scanSchedule,
        }),
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? 'Failed to create brand');
      }

      const json = await res.json();
      router.push(`/brands/${json.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  return (
    <AuthGuard>
      <Navbar />
      <main className="pt-16 min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-3 mb-8">
            <Link href="/brands" className="text-gray-500 hover:text-gray-900 transition">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Add Brand</h1>
              <p className="text-sm text-gray-500 mt-0.5">Tell DoppelSpotter what it should monitor</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <Card>
              <CardHeader className="px-6 py-5">
                <h2 className="font-semibold text-gray-900">Brand details</h2>
              </CardHeader>
              <CardContent className="space-y-7 p-6">
                <Input
                  id="name"
                  label="Brand name"
                  placeholder="Enter your primary brand name ..."
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  tooltip="The primary name you want to monitor across all surfaces."
                />

                {/* Keywords */}
                <TagInput
                  id="keywords"
                  label={(
                    <>
                      Keywords <span className="text-gray-400 font-normal">(optional)</span>
                    </>
                  )}
                  tooltip="The words associated with your brand that you want to protect and monitor (e.g. your trademarks). Scans will search for these keywords."
                  values={keywords}
                  inputValue={keywordInput}
                  onInputChange={setKeywordInput}
                  onAdd={addKeyword}
                  onRemove={removeKeyword}
                  placeholder="Type a keyword and press enter..."
                />

                {/* Official domains */}
                <TagInput
                  id="official-domains"
                  label={(
                    <>
                      Official domains <span className="text-gray-400 font-normal">(optional)</span>
                    </>
                  )}
                  tooltip="Domains that you own, so that the AI analysis knows not to flag them."
                  values={domains}
                  inputValue={domainInput}
                  onInputChange={(value) => {
                    setDomainInput(value);
                    if (domainError) {
                      setDomainError('');
                    }
                  }}
                  onAdd={addDomain}
                  onRemove={removeDomain}
                  error={domainError}
                  placeholder="Type a domain and press enter..."
                />

                {/* Watch words */}
                <TagInput
                  id="watch-words"
                  label={(
                    <>
                      Watch words <span className="text-gray-400 font-normal">(optional)</span>
                    </>
                  )}
                  tooltip="Words that you don't want to be associated with your brand. Scans won't search for these words, but if they appear in scan results the AI analysis will treat the results with more caution."
                  values={watchWords}
                  inputValue={watchWordInput}
                  onInputChange={setWatchWordInput}
                  onAdd={addWatchWord}
                  onRemove={removeWatchWord}
                  placeholder="Type a watch word and press enter..."
                />

                {/* Safe words */}
                <TagInput
                  id="safe-words"
                  label={(
                    <>
                      Safe words <span className="text-gray-400 font-normal">(optional)</span>
                    </>
                  )}
                  tooltip="Words that you're happy to be associated with your brand. If they appear in scan results the AI analysis will treat the results with less caution."
                  values={safeWords}
                  inputValue={safeWordInput}
                  onInputChange={setSafeWordInput}
                  onAdd={addSafeWord}
                  onRemove={removeSafeWord}
                  placeholder="Type a safe word and press enter..."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-6 py-5">
                <h2 className="font-semibold text-gray-900">Scan settings</h2>
              </CardHeader>
              <CardContent className="space-y-7 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                      Send scan summary emails
                      <InfoTooltip content="When a scan completes, DoppelSpotter will email a summary to your account email address." />
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={sendScanSummaryEmails}
                    aria-label="Send scan summary emails"
                    onClick={() => setSendScanSummaryEmails((prev) => !prev)}
                    className={`inline-flex items-center gap-2 rounded-md text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      sendScanSummaryEmails ? 'text-brand-700' : 'text-gray-600'
                    }`}
                  >
                    <span>{sendScanSummaryEmails ? 'On' : 'Off'}</span>
                    <span
                      className={`relative inline-flex h-6 w-11 rounded-full transition ${
                        sendScanSummaryEmails ? 'bg-brand-600' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                          sendScanSummaryEmails ? 'left-[22px]' : 'left-0.5'
                        }`}
                      />
                    </span>
                  </button>
                </div>

                <BrandScanScheduleFields
                  value={scanSchedule}
                  onChange={setScanSchedule}
                />

                <BrandScanTuningFields
                  searchResultPages={searchResultPages}
                  onSearchResultPagesChange={setSearchResultPages}
                  allowAiDeepSearches={allowAiDeepSearches}
                  onAllowAiDeepSearchesChange={setAllowAiDeepSearches}
                  maxAiDeepSearches={maxAiDeepSearches}
                  onMaxAiDeepSearchesChange={setMaxAiDeepSearches}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-6 py-5">
                <div className="inline-flex items-center gap-1.5">
                  <h2 className="font-semibold text-gray-900">Scan types</h2>
                  <InfoTooltip content="Choose which scan types DoppelSpotter should run for this brand. At least one scan source must remain enabled." />
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <BrandScanSourceFields value={scanSources} onChange={setScanSources} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-6 py-5">
                <div className="inline-flex items-center gap-1.5">
                  <h2 className="font-semibold text-gray-900">Analysis settings</h2>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <BrandAnalysisSettingsFields
                  value={analysisSeverityDefinitions}
                  onChange={setAnalysisSeverityDefinitions}
                />
              </CardContent>
            </Card>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                {error}
              </p>
            )}

            <div className="flex gap-3 justify-end">
              <Link href="/brands">
                <Button type="button" variant="secondary">Cancel</Button>
              </Link>
              <Button type="submit" loading={loading}>
                Create brand profile
              </Button>
            </div>
          </form>
        </div>
      </main>
    </AuthGuard>
  );
}
