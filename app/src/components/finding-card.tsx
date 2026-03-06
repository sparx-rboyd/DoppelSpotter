'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Globe,
  Instagram,
  Twitter,
  Facebook,
  Search,
  Smartphone,
  BookMarked,
  Sparkles,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Code2,
  MessageSquare,
  EyeOff,
  Eye,
  Loader2,
  Bookmark,
  StickyNote,
  Check,
  Trash2,
  Pencil,
  X,
} from 'lucide-react';
import { type Finding, type FindingSource, type FindingSummary } from '@/lib/types';
import { SeverityBadge } from './severity-badge';
import { cn } from '@/lib/utils';

type BookmarkUpdate = {
  isBookmarked?: boolean;
  bookmarkNote?: string | null;
};

interface FindingCardProps {
  finding: FindingSummary;
  className?: string;
  /**
   * Called when the user toggles the ignored state.
   * Receives the lightweight list item (which still includes the URL/scanId needed
   * for optimistic UI updates) and the new desired ignored state.
   */
  onIgnoreToggle?: (finding: FindingSummary, isIgnored: boolean) => Promise<void>;
  /**
   * Called when the user bookmarks/unbookmarks a finding or updates its note.
   */
  onBookmarkUpdate?: (finding: FindingSummary, updates: BookmarkUpdate) => Promise<void>;
}

const sourceConfig: Record<
  FindingSource,
  { icon: React.ElementType; bgClass: string; textClass: string; label: string }
> = {
  domain: {
    icon: Globe,
    bgClass: 'bg-red-50',
    textClass: 'text-red-600',
    label: 'Domain',
  },
  instagram: {
    icon: Instagram,
    bgClass: 'bg-amber-50',
    textClass: 'text-amber-600',
    label: 'Instagram',
  },
  twitter: {
    icon: Twitter,
    bgClass: 'bg-sky-50',
    textClass: 'text-sky-600',
    label: 'Twitter / X',
  },
  facebook: {
    icon: Facebook,
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-600',
    label: 'Facebook',
  },
  tiktok: {
    icon: Smartphone,
    bgClass: 'bg-gray-50',
    textClass: 'text-gray-600',
    label: 'TikTok',
  },
  google: {
    icon: Search,
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: 'Google Search',
  },
  'google-play': {
    icon: Smartphone,
    bgClass: 'bg-green-50',
    textClass: 'text-green-600',
    label: 'Google Play',
  },
  'app-store': {
    icon: Smartphone,
    bgClass: 'bg-gray-50',
    textClass: 'text-gray-600',
    label: 'App Store',
  },
  trademark: {
    icon: BookMarked,
    bgClass: 'bg-purple-50',
    textClass: 'text-purple-600',
    label: 'Trademark',
  },
  unknown: {
    icon: Globe,
    bgClass: 'bg-gray-50',
    textClass: 'text-gray-500',
    label: 'Unknown',
  },
};

function ExpandableSection({
  icon: Icon,
  label,
  onOpen,
  loading = false,
  error,
  children,
}: {
  icon: React.ElementType;
  label: string;
  onOpen?: () => void;
  loading?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpen?.();
      return next;
    });
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 transition text-left"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        )}
        <Icon className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        <span className="text-xs font-medium text-gray-600">{label}</span>
      </button>
      {open && loading && (
        <div className="p-3 text-xs text-gray-500 bg-white border-t border-gray-200 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading debug data...
        </div>
      )}
      {open && !loading && error && (
        <div className="p-3 text-xs text-red-600 bg-white border-t border-gray-200">
          {error}
        </div>
      )}
      {open && !loading && !error && (
        <pre className="p-3 text-xs text-gray-700 bg-white overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed max-h-80 overflow-y-auto border-t border-gray-200">
          {children}
        </pre>
      )}
    </div>
  );
}

export function FindingCard({
  finding,
  className,
  onIgnoreToggle,
  onBookmarkUpdate,
}: FindingCardProps) {
  const src = sourceConfig[finding.source] ?? sourceConfig.unknown;
  const Icon = src.icon;
  const isFalsePositive = finding.isFalsePositive === true;
  const isIgnored = finding.isIgnored === true;
  const isBookmarked = finding.isBookmarked === true;
  const muted = isFalsePositive || isIgnored;

  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';

  const [ignoring, setIgnoring] = useState(false);
  const [bookmarking, setBookmarking] = useState(false);
  const [editingBookmarkNote, setEditingBookmarkNote] = useState(false);
  const [bookmarkNoteDraft, setBookmarkNoteDraft] = useState(finding.bookmarkNote ?? '');
  const [debugFinding, setDebugFinding] = useState<Finding | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState('');

  useEffect(() => {
    if (!editingBookmarkNote) {
      setBookmarkNoteDraft(finding.bookmarkNote ?? '');
    }
  }, [editingBookmarkNote, finding.bookmarkNote]);

  async function handleIgnoreToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onIgnoreToggle || ignoring) return;
    setIgnoring(true);
    try {
      await onIgnoreToggle(finding, !isIgnored);
    } finally {
      setIgnoring(false);
    }
  }

  async function handleBookmarkToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onBookmarkUpdate || bookmarking) return;
    const nextIsBookmarked = !isBookmarked;
    setBookmarking(true);
    try {
      await onBookmarkUpdate(finding, {
        isBookmarked: nextIsBookmarked,
        bookmarkNote: nextIsBookmarked ? undefined : null,
      });
      if (nextIsBookmarked) {
        setEditingBookmarkNote(finding.bookmarkNote ? false : true);
      } else {
        setEditingBookmarkNote(false);
        setBookmarkNoteDraft('');
      }
    } finally {
      setBookmarking(false);
    }
  }

  async function saveBookmarkNote(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onBookmarkUpdate || bookmarking) return;
    setBookmarking(true);
    try {
      await onBookmarkUpdate(finding, { bookmarkNote: bookmarkNoteDraft });
      setEditingBookmarkNote(false);
    } finally {
      setBookmarking(false);
    }
  }

  async function deleteBookmarkNote(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onBookmarkUpdate || bookmarking) return;
    setBookmarking(true);
    try {
      await onBookmarkUpdate(finding, { bookmarkNote: null });
      setBookmarkNoteDraft('');
      setEditingBookmarkNote(false);
    } finally {
      setBookmarking(false);
    }
  }

  async function ensureDebugFinding() {
    if (debugFinding || debugLoading) return;

    setDebugLoading(true);
    setDebugError('');
    try {
      const res = await fetch(`/api/brands/${finding.brandId}/findings/${finding.id}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to load debug data');
      const json = await res.json();
      setDebugFinding(json.data ?? null);
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : 'Failed to load debug data');
    } finally {
      setDebugLoading(false);
    }
  }

  return (
    <div
      className={cn(
        'bg-white p-4 sm:p-5 rounded-xl border',
        muted
          ? 'border-gray-200 opacity-75'
          : 'border-gray-200 hover:border-gray-300 transition',
        className,
      )}
    >
      {/* Source icon */}
      <div className="flex items-start gap-3 sm:gap-5">
        <div
          className={cn(
            'p-2 sm:p-3 rounded-lg flex-shrink-0',
            muted ? 'bg-gray-100 text-gray-400' : cn(src.bgClass, src.textClass),
          )}
        >
          <Icon className="w-5 h-5 sm:w-6 sm:h-6" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex flex-wrap items-center gap-2.5 mb-2.5">
            <h4
              className={cn(
                'font-semibold text-sm',
                muted ? 'text-gray-500' : 'text-gray-900',
              )}
            >
              {finding.title}
            </h4>
            {isIgnored ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-gray-100 text-gray-500 border border-transparent">
                <EyeOff className="w-3.5 h-3.5" />
                Ignored
              </span>
            ) : isFalsePositive ? (
              <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-gray-100 text-gray-500 border border-transparent">
                Non-hit
              </span>
            ) : (
              <SeverityBadge severity={finding.severity} />
            )}
            {isBookmarked && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-100">
                <Bookmark className="w-3.5 h-3.5" />
                Bookmarked
              </span>
            )}
            {finding.url && (
              <a
                href={finding.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
                Visit
              </a>
            )}
            {/* Ignore / un-ignore button — shown for real findings and non-hits alike */}
            {onIgnoreToggle && (
              <button
                type="button"
                onClick={handleIgnoreToggle}
                disabled={ignoring}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition',
                  isIgnored
                    ? 'bg-gray-900 text-white border-transparent hover:bg-black'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                )}
              >
                {ignoring ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : isIgnored ? (
                  <Eye className="w-3.5 h-3.5" />
                ) : (
                  <EyeOff className="w-3.5 h-3.5 text-gray-400" />
                )}
                {isIgnored ? 'Un-ignore' : 'Ignore'}
              </button>
            )}
            {onBookmarkUpdate && (
              <button
                type="button"
                onClick={handleBookmarkToggle}
                disabled={bookmarking}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border transition',
                  isBookmarked
                    ? 'bg-brand-600 text-white border-transparent hover:bg-brand-700'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                )}
              >
                {bookmarking ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Bookmark className={cn('w-3.5 h-3.5', isBookmarked ? '' : 'text-gray-400')} />
                )}
                {isBookmarked ? 'Unbookmark' : 'Bookmark'}
              </button>
            )}
          </div>

          {/* AI analysis box */}
          <div className="bg-gray-50 rounded-lg p-2 sm:p-3 text-xs sm:text-sm text-gray-600 border border-gray-100 flex items-start gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-brand-500 mt-0.5 flex-shrink-0" />
            <p>
              <strong>AI analysis:</strong>{' '}
              {finding.llmAnalysis}
            </p>
          </div>

          {isBookmarked && (
            <div className="mb-3 rounded-lg border border-brand-100 bg-brand-50/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0">
                  <StickyNote className="w-4 h-4 text-brand-600 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-brand-900">Bookmark note</p>
                    {!editingBookmarkNote && finding.bookmarkNote && (
                      <p className="mt-1 text-xs sm:text-sm text-brand-900 whitespace-pre-wrap break-words">
                        {finding.bookmarkNote}
                      </p>
                    )}
                    {!editingBookmarkNote && !finding.bookmarkNote && (
                      <p className="mt-1 text-xs text-brand-700/55">
                        Add a reminder to yourself
                      </p>
                    )}
                  </div>
                </div>
                {onBookmarkUpdate && !editingBookmarkNote && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBookmarkNoteDraft(finding.bookmarkNote ?? '');
                        setEditingBookmarkNote(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 transition"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      {finding.bookmarkNote ? 'Edit note' : 'Add note'}
                    </button>
                    {finding.bookmarkNote && (
                      <button
                        type="button"
                        onClick={deleteBookmarkNote}
                        disabled={bookmarking}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 transition disabled:opacity-60"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete note
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editingBookmarkNote && onBookmarkUpdate && (
                <div className="mt-3">
                  <textarea
                    value={bookmarkNoteDraft}
                    onChange={(e) => setBookmarkNoteDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    rows={3}
                    maxLength={2000}
                    placeholder="Add a reminder to yourself..."
                    className="w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-brand-800/70">
                      {bookmarkNoteDraft.trim().length}/2000
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingBookmarkNote(false);
                          setBookmarkNoteDraft(finding.bookmarkNote ?? '');
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-white transition"
                      >
                        <X className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveBookmarkNote}
                        disabled={bookmarking}
                        className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 transition disabled:opacity-60"
                      >
                        {bookmarking ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        Save note
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Debug expandables — visible only when ?debug=true */}
          {showDebug && (
            <div className="space-y-1.5">
              <ExpandableSection
                icon={MessageSquare}
                label="Raw AI response"
                onOpen={ensureDebugFinding}
                loading={debugLoading}
                error={debugError}
              >
                {debugFinding?.rawLlmResponse
                  ? (() => {
                      try {
                        return JSON.stringify(JSON.parse(debugFinding.rawLlmResponse), null, 2);
                      } catch {
                        return debugFinding.rawLlmResponse;
                      }
                    })()
                  : '(not available — AI analysis may have failed or this is a legacy finding)'}
              </ExpandableSection>

              <ExpandableSection
                icon={Code2}
                label="Stored debug data"
                onOpen={ensureDebugFinding}
                loading={debugLoading}
                error={debugError}
              >
                {debugFinding?.rawData
                  ? JSON.stringify(debugFinding.rawData, null, 2)
                  : '(not available — this is a lightweight list item)'}
              </ExpandableSection>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
