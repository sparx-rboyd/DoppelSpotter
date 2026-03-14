'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
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
  DEFAULT_LOOKBACK_PERIOD,
  DEFAULT_SEARCH_RESULT_PAGES,
  DEFAULT_ALLOW_AI_DEEP_SEARCHES,
  DEFAULT_BRAND_SCAN_SOURCES,
  normalizeSearchResultPages,
  normalizeAllowAiDeepSearches,
  normalizeBrandScanSources,
  normalizeLookbackPeriod,
  normalizeMaxAiDeepSearches,
  DEFAULT_MAX_AI_DEEP_SEARCHES,
  MAX_BRAND_KEYWORDS,
  hasEnabledBrandScanSource,
} from '@/lib/brands';
import {
  isValidBrandAnalysisSeverityDefinitions,
  normalizeBrandAnalysisSeverityDefinitions,
} from '@/lib/analysis-severity';
import {
  DEFAULT_SCAN_SCHEDULE_FREQUENCY,
  getBrowserTimeZone,
  getDefaultScheduleStartInput,
  getScheduleInputFromBrandSchedule,
  isScheduleStartInPast,
} from '@/lib/scan-schedules';
import type { BrandAnalysisSeverityDefinitions, BrandProfile, BrandScanScheduleInput, LookbackPeriod } from '@/lib/types';

export default function EditBrandPage() {
  const { brandId } = useParams<{ brandId: string }>();
  const router = useRouter();

  const [loadError, setLoadError] = useState('');
  const [loadingBrand, setLoadingBrand] = useState(true);

  const [name, setName] = useState('');
  usePageTitle(name ? `Edit "${name}"` : 'Edit Brand');
  const [keywordInput, setKeywordInput] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordError, setKeywordError] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [domainError, setDomainError] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [watchWordInput, setWatchWordInput] = useState('');
  const [watchWords, setWatchWords] = useState<string[]>([]);
  const [safeWordInput, setSafeWordInput] = useState('');
  const [safeWords, setSafeWords] = useState<string[]>([]);
  const [sendScanSummaryEmails, setSendScanSummaryEmails] = useState(true);
  const [lookbackPeriod, setLookbackPeriod] = useState<LookbackPeriod>(DEFAULT_LOOKBACK_PERIOD);
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
  const [initialScanSchedule, setInitialScanSchedule] = useState<BrandScanScheduleInput | null>(null);
  const [lookbackNudgeDismissed, setLookbackNudgeDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const keywordLimitReached = keywords.length >= MAX_BRAND_KEYWORDS;

  useEffect(() => {
    async function fetchBrand() {
      setLoadError('');
      setLoadingBrand(true);
      try {
        const res = await fetch(`/api/brands/${brandId}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Brand not found');
        const json = await res.json();
        const brand: BrandProfile = json.data;
        setName(brand.name);
        setKeywords(brand.keywords);
        setDomains(brand.officialDomains);
        setSendScanSummaryEmails(brand.sendScanSummaryEmails ?? true);
        setLookbackPeriod(normalizeLookbackPeriod(brand.lookbackPeriod));
        setSearchResultPages(normalizeSearchResultPages(brand.searchResultPages));
        setAllowAiDeepSearches(normalizeAllowAiDeepSearches(brand.allowAiDeepSearches));
        setMaxAiDeepSearches(normalizeMaxAiDeepSearches(brand.maxAiDeepSearches));
        setScanSources(normalizeBrandScanSources(brand.scanSources));
        setAnalysisSeverityDefinitions(normalizeBrandAnalysisSeverityDefinitions(brand.analysisSeverityDefinitions));
        setWatchWords(brand.watchWords ?? []);
        setSafeWords(brand.safeWords ?? []);
        const resolvedScanSchedule = getScheduleInputFromBrandSchedule(brand.scanSchedule);
        setScanSchedule(resolvedScanSchedule);
        setInitialScanSchedule(resolvedScanSchedule);
        setLookbackNudgeDismissed(brand.lookbackNudgeDismissed === true);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load brand');
      } finally {
        setLoadingBrand(false);
      }
    }
    fetchBrand();
  }, [brandId]);

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

  function addKeyword() {
    const trimmed = keywordInput.trim().toLowerCase();
    if (!trimmed) {
      setKeywordInput('');
      return;
    }
    if (keywords.includes(trimmed)) {
      setKeywordInput('');
      setKeywordError('');
      return;
    }
    if (keywordLimitReached) {
      setKeywordError(`You can add up to ${MAX_BRAND_KEYWORDS} protected keywords`);
      return;
    }
    setKeywords([...keywords, trimmed]);
    setKeywordError('');
    setKeywordInput('');
  }

  function removeKeyword(kw: string) {
    setKeywords(keywords.filter((k) => k !== kw));
    setKeywordError('');
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

  function hasUnchangedScheduleStart(nextSchedule: BrandScanScheduleInput): boolean {
    if (!initialScanSchedule?.enabled) {
      return false;
    }

    return (
      nextSchedule.timeZone === initialScanSchedule.timeZone &&
      nextSchedule.startDate === initialScanSchedule.startDate &&
      nextSchedule.startTime === initialScanSchedule.startTime
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (keywords.length > MAX_BRAND_KEYWORDS) {
      setKeywordError(`You can add up to ${MAX_BRAND_KEYWORDS} protected keywords`);
      return;
    }
    if (!hasEnabledBrandScanSource(scanSources)) {
      setSaveError('At least one scan source must be enabled');
      return;
    }
    if (!isValidBrandAnalysisSeverityDefinitions(analysisSeverityDefinitions)) {
      setSaveError('Custom analysis severity definitions must be non-empty and no longer than 1500 characters');
      return;
    }

    if (scanSchedule.enabled && isScheduleStartInPast(scanSchedule) && !hasUnchangedScheduleStart(scanSchedule)) {
      setSaveError('Scheduled scan start date and time must be in the future');
      return;
    }

    setSaving(true);
    setSaveError('');

    try {
      const res = await fetch(`/api/brands/${brandId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: name.trim(),
          keywords,
          officialDomains: domains,
          searchResultPages,
          lookbackPeriod,
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
        throw new Error(json.error ?? 'Failed to save changes');
      }

      router.push(`/brands/${brandId}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unknown error');
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    setSaveError('');

    try {
      const res = await fetch(`/api/brands/${brandId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!res.ok) {
        let errorMessage = 'Failed to delete brand';

        try {
          const json = await res.json();
          errorMessage = json.error ?? errorMessage;
        } catch {
          // Ignore non-JSON error bodies and fall back to the generic message.
        }

        throw new Error(errorMessage);
      }

      setIsDeleteDialogOpen(false);
      router.push('/brands');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unknown error');
      setDeleting(false);
    }
  }

  return (
    <AuthGuard>
      <Navbar />
      <main className="min-h-screen bg-gray-50 pt-16 lg:pt-[4.5rem]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8 lg:py-10 xl:max-w-[88rem]">
          <div className="mb-8 flex items-center gap-3 lg:mb-8 lg:gap-4">
            <Link href={`/brands/${brandId}`} className="text-gray-500 hover:text-gray-900 transition">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Brand Settings</h1>
              <p className="text-sm text-gray-500 mt-0.5">Update your brand monitoring settings</p>
            </div>
          </div>

          {loadingBrand && (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {loadError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
              {loadError}
            </p>
          )}

          {!loadingBrand && !loadError && (
            <form onSubmit={handleSubmit} className="space-y-6 lg:space-y-8">
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
                        Protected keywords <span className="text-gray-400 font-normal">(optional)</span>
                      </>
                    )}
                    tooltip="The words associated with your brand that you want to protect and monitor (e.g. your trademarks). Scans will search for these keywords."
                    values={keywords}
                    inputValue={keywordInput}
                    onInputChange={(value) => {
                      setKeywordInput(value);
                      if (keywordError) {
                        setKeywordError('');
                      }
                    }}
                    onAdd={addKeyword}
                    onRemove={removeKeyword}
                    placeholder={keywordLimitReached ? `Maximum ${MAX_BRAND_KEYWORDS} protected keywords reached` : 'Type a keyword and press enter...'}
                    error={keywordError}
                    hint={`${keywords.length}/${MAX_BRAND_KEYWORDS} protected keywords`}
                    inputDisabled={keywordLimitReached && keywordInput.length === 0}
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
                    lookbackPeriod={lookbackPeriod}
                    onLookbackPeriodChange={setLookbackPeriod}
                    searchResultPages={searchResultPages}
                    onSearchResultPagesChange={setSearchResultPages}
                    allowAiDeepSearches={allowAiDeepSearches}
                    onAllowAiDeepSearchesChange={setAllowAiDeepSearches}
                    maxAiDeepSearches={maxAiDeepSearches}
                    onMaxAiDeepSearchesChange={setMaxAiDeepSearches}
                    hideInfoMessage={lookbackNudgeDismissed}
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

              {saveError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                  {saveError}
                </p>
              )}

              <div className="flex justify-end gap-3 lg:gap-4">
                <Link href={`/brands/${brandId}`}>
                  <Button type="button" variant="secondary" disabled={deleting}>Cancel</Button>
                </Link>
                <Button type="submit" loading={saving} disabled={deleting}>
                  Save changes
                </Button>
              </div>

              <Card className="border-red-200 bg-red-50/40">
                <CardHeader className="px-6 py-5">
                  <h2 className="font-semibold text-red-700">Danger zone</h2>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 bg-red-50/40 p-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="font-medium text-gray-900">Delete this brand</p>
                    <p className="text-sm text-gray-500">
                      Permanently delete this brand and all scan results. This action cannot be undone.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    loading={deleting}
                    disabled={saving}
                    onClick={() => {
                      setDeleteError('');
                      setIsDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete brand
                  </Button>
                </CardContent>
              </Card>

              {deleteError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                  {deleteError}
                </p>
              )}
            </form>
          )}
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
              aria-labelledby="delete-brand-title"
              aria-describedby="delete-brand-description"
              className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
                  <Trash2 className="h-5 w-5 text-red-600" />
                </div>
                <div className="min-w-0">
                  <h2 id="delete-brand-title" className="text-lg font-semibold text-gray-900">
                    Delete {name.trim() ? `"${name.trim()}"` : 'this brand'}?
                  </h2>
                  <p id="delete-brand-description" className="mt-2 text-sm leading-6 text-gray-600">
                    This will permanently delete the brand and all scan results. This action cannot be undone.
                  </p>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3 lg:gap-4">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={deleting}
                  onClick={() => setIsDeleteDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  loading={deleting}
                  onClick={handleDelete}
                >
                  Delete brand
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}
