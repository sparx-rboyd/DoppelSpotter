'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, X } from 'lucide-react';
import Link from 'next/link';
import { AuthGuard } from '@/components/auth-guard';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { InfoTooltip } from '@/components/ui/tooltip';

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
      setDomainError('Please enter a valid domain (e.g. acme.com)');
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

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/brands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name.trim(), keywords, officialDomains: domains, watchWords, safeWords }),
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
              <h1 className="text-2xl font-bold text-gray-900">Add Brand Profile</h1>
              <p className="text-sm text-gray-500 mt-0.5">Configure what DoppelSpotter should monitor</p>
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
                  placeholder="e.g. Acme Corp"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  tooltip="The primary name you want to monitor across all surfaces."
                />

                {/* Keywords */}
                <div className="flex flex-col gap-2">
                  <label className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                    Keywords <span className="text-gray-400 font-normal">(optional)</span>
                    <InfoTooltip content="The words associated with your brand that you want to protect and monitor (e.g. your trademarks). Scans will search for these keywords." />
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={keywordInput}
                      onChange={(e) => setKeywordInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
                      }}
                      placeholder="Add a keyword and press Enter"
                      className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addKeyword}>
                      Add
                    </Button>
                  </div>
                    {keywords.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 mt-1">
                        {keywords.map((kw) => (
                          <Badge key={kw} variant="default">
                            {kw}
                            <button type="button" onClick={() => removeKeyword(kw)} className="ml-1 hover:opacity-70">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                </div>

                {/* Official domains */}
                <div className="flex flex-col gap-2">
                  <label className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                    Official domains <span className="text-gray-400 font-normal">(optional)</span>
                    <InfoTooltip content="Domains that you own, so that the AI analysis knows not to flag them." />
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(e) => { setDomainInput(e.target.value); setDomainError(''); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addDomain(); }
                      }}
                      placeholder="e.g. acme.com"
                      className={`flex-1 px-3 py-2 rounded-lg border text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition ${domainError ? 'border-red-400' : 'border-gray-300'}`}
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addDomain}>
                      Add
                    </Button>
                  </div>
                  {domainError && (
                    <p className="text-xs text-red-600">{domainError}</p>
                  )}
                    {domains.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 mt-1">
                        {domains.map((d) => (
                          <Badge key={d} variant="default">
                            {d}
                            <button type="button" onClick={() => removeDomain(d)} className="ml-1 hover:opacity-70">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                </div>

                {/* Watch words */}
                <div className="flex flex-col gap-2">
                  <label className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                    Watch words <span className="text-gray-400 font-normal">(optional)</span>
                    <InfoTooltip content="Words that you don't want to be associated with your brand. Scans won't search for these words, but if they appear in scan results the AI analysis will treat the results with more caution." />
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={watchWordInput}
                      onChange={(e) => setWatchWordInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addWatchWord(); }
                      }}
                      placeholder="Add a watch word and press Enter"
                      className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addWatchWord}>
                      Add
                    </Button>
                  </div>
                    {watchWords.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 mt-1">
                        {watchWords.map((w) => (
                          <Badge key={w} variant="default">
                            {w}
                            <button type="button" onClick={() => removeWatchWord(w)} className="ml-1 hover:opacity-70">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                </div>

                {/* Safe words */}
                <div className="flex flex-col gap-2">
                  <label className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                    Safe words <span className="text-gray-400 font-normal">(optional)</span>
                    <InfoTooltip content="Words that you're happy to be associated with your brand. If they appear in scan results the AI analysis will treat the results with less caution." />
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={safeWordInput}
                      onChange={(e) => setSafeWordInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addSafeWord(); }
                      }}
                      placeholder="Add a safe word and press Enter"
                      className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={addSafeWord}>
                      Add
                    </Button>
                  </div>
                    {safeWords.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 mt-1">
                        {safeWords.map((w) => (
                          <Badge key={w} variant="default">
                            {w}
                            <button type="button" onClick={() => removeSafeWord(w)} className="ml-1 hover:opacity-70">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                </div>
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
