'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  Info,
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
  Crosshair,
  SearchCheck,
  MoreHorizontal,
} from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import { type Finding, type FindingCategory, type FindingSource, type FindingSummary } from '@/lib/types';
import { getFindingSourceLabel } from '@/lib/scan-sources';
import { cn } from '@/lib/utils';
import { ScanSourceIcon } from './scan-source-icon';
import { Tooltip } from './ui/tooltip';

type BookmarkUpdate = {
  isBookmarked?: boolean;
};

interface FindingCardProps {
  finding: FindingSummary;
  className?: string;
  highlightQuery?: string;
  isSelected?: boolean;
  onSelectionChange?: (finding: FindingSummary, selected: boolean) => void;
  /** Called when the user toggles the ignored state for a real finding. */
  onIgnoreToggle?: (finding: FindingSummary, isIgnored: boolean) => Promise<void>;
  /** Called when the user toggles the addressed state for a real finding. */
  onAddressToggle?: (finding: FindingSummary, isAddressed: boolean) => Promise<void>;
  /** Called when the user reclassifies a finding into another category. */
  onReclassify?: (finding: FindingSummary, category: FindingCategory) => Promise<void>;
  /** Called when the user bookmarks or unbookmarks a finding. */
  onBookmarkUpdate?: (finding: FindingSummary, updates: BookmarkUpdate) => Promise<void>;
  /** Called when the user adds, edits, or deletes a note for this finding. */
  onNoteUpdate?: (finding: FindingSummary, note: string | null) => Promise<void>;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query?: string) {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) return text;

  const matcher = new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'gi');
  const parts = text.split(matcher);

  if (parts.length === 1) return text;

  return parts.map((part, index) => (
    part.toLowerCase() === trimmedQuery.toLowerCase()
      ? (
        <mark
          key={`${part}-${index}`}
          className="rounded-[2px] bg-yellow-200/80 text-inherit"
        >
          {part}
        </mark>
      )
      : part
  ));
}

function extractDomainLabel(url?: string) {
  if (!url) return null;

  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;

  const candidates = trimmedUrl.includes('://')
    ? [trimmedUrl]
    : [`https://${trimmedUrl}`, trimmedUrl];

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      return parsed.hostname || trimmedUrl;
    } catch {
      continue;
    }
  }

  return trimmedUrl;
}

function truncateMiddle(value: string, maxLength = 44, headLength = 18, tailLength = 23) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function SelectionCheckbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? 'Deselect finding' : 'Select finding'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        'inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        checked
          ? 'border-slate-500 bg-slate-500 text-white'
          : 'border-gray-300 bg-gray-50 text-transparent hover:border-gray-400 hover:bg-gray-100',
      )}
    >
      <Check className="h-3 w-3" />
    </button>
  );
}

function shouldIgnoreCardSelectionClick(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      'a, button, input, textarea, select, label, summary, [role="button"], [role="checkbox"], [data-prevent-selection-toggle="true"]',
    ),
  );
}

const sourceConfig: Record<
  FindingSource,
  {
    bgClass: string;
    textClass: string;
    label: string;
  }
> = {
  google: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('google'),
  },
  reddit: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('reddit'),
  },
  tiktok: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('tiktok'),
  },
  youtube: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('youtube'),
  },
  facebook: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('facebook'),
  },
  instagram: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('instagram'),
  },
  telegram: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('telegram'),
  },
  apple_app_store: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('apple_app_store'),
  },
  google_play: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('google_play'),
  },
  domains: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('domains'),
  },
  discord: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('discord'),
  },
  github: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('github'),
  },
  x: {
    bgClass: 'bg-brand-50',
    textClass: 'text-brand-600',
    label: getFindingSourceLabel('x'),
  },
  unknown: {
    bgClass: 'bg-gray-50',
    textClass: 'text-gray-500',
    label: getFindingSourceLabel('unknown'),
  },
};

const severityConfig = {
  high: {
    label: 'High severity',
    icon: AlertCircle,
    className: 'text-red-600',
  },
  medium: {
    label: 'Medium severity',
    icon: AlertTriangle,
    className: 'text-amber-600',
  },
  low: {
    label: 'Low severity',
    icon: Info,
    className: 'text-emerald-600',
  },
} as const;

const categoryConfig = {
  high: {
    label: 'High',
    description: 'Move this finding into the high findings section.',
    icon: AlertCircle,
    className: 'text-red-600',
  },
  medium: {
    label: 'Medium',
    description: 'Move this finding into the medium findings section.',
    icon: AlertTriangle,
    className: 'text-amber-600',
  },
  low: {
    label: 'Low',
    description: 'Move this finding into the low findings section.',
    icon: Info,
    className: 'text-emerald-600',
  },
  'non-hit': {
    label: 'Non-finding',
    description: 'Move this finding into the non-findings section.',
    icon: SearchCheck,
    className: 'text-gray-600',
  },
} as const;

function getFindingCategory(finding: FindingSummary): FindingCategory {
  return finding.isFalsePositive === true ? 'non-hit' : finding.severity;
}

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
    const next = !open;
    setOpen(next);
    if (next) {
      onOpen?.();
    }
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
  highlightQuery,
  isSelected = false,
  onSelectionChange,
  onIgnoreToggle,
  onAddressToggle,
  onReclassify,
  onBookmarkUpdate,
  onNoteUpdate,
}: FindingCardProps) {
  const { user, refreshSession } = useAuth();
  const src = sourceConfig[finding.source] ?? sourceConfig.unknown;
  const isFalsePositive = finding.isFalsePositive === true;
  const isIgnored = finding.isIgnored === true;
  const isAddressed = finding.isAddressed === true;
  const isBookmarked = finding.isBookmarked === true;
  const hasNote = Boolean(finding.bookmarkNote?.trim());
  const muted = isFalsePositive || isIgnored || isAddressed;
  const severityMeta = severityConfig[finding.severity];
  const SeverityIcon = severityMeta.icon;

  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';

  const [ignoring, setIgnoring] = useState(false);
  const [addressing, setAddressing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [isReclassifyDialogOpen, setIsReclassifyDialogOpen] = useState(false);
  const [isDomainVisitDialogOpen, setIsDomainVisitDialogOpen] = useState(false);
  const [skipDomainVisitWarningForFuture, setSkipDomainVisitWarningForFuture] = useState(false);
  const [savingDomainVisitPreference, setSavingDomainVisitPreference] = useState(false);
  const [domainVisitError, setDomainVisitError] = useState('');
  const [selectedReclassificationCategory, setSelectedReclassificationCategory] = useState<FindingCategory | null>(null);
  const [bookmarking, setBookmarking] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(finding.bookmarkNote ?? '');
  const [savingNote, setSavingNote] = useState(false);
  const [debugFinding, setDebugFinding] = useState<Finding | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState('');
  const [isMoreActionsMenuOpen, setIsMoreActionsMenuOpen] = useState(false);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  const currentCategory = getFindingCategory(finding);
  const shouldShowMatchedUrl = Boolean(
    finding.url
    && highlightQuery?.trim()
    && finding.url.toLowerCase().includes(highlightQuery.trim().toLowerCase()),
  );
  const domainLabel = finding.source === 'domains' ? extractDomainLabel(finding.url) : null;
  const truncatedDomainLabel = domainLabel ? truncateMiddle(domainLabel) : null;
  const isDomainLabelTruncated = Boolean(domainLabel && truncatedDomainLabel && domainLabel !== truncatedDomainLabel);
  const shouldWarnBeforeDomainVisit = finding.source === 'domains'
    && user?.preferences?.skipDomainRegistrationVisitWarning !== true;

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!editingNote) {
      setNoteDraft(finding.bookmarkNote ?? '');
    }
  }, [editingNote, finding.bookmarkNote]);

  useEffect(() => {
    if (!isReclassifyDialogOpen && !isDomainVisitDialogOpen) return undefined;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isDomainVisitDialogOpen, isReclassifyDialogOpen]);

  useEffect(() => {
    if (!isReclassifyDialogOpen && !isDomainVisitDialogOpen) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isDomainVisitDialogOpen && !savingDomainVisitPreference) {
        setIsDomainVisitDialogOpen(false);
        setSkipDomainVisitWarningForFuture(false);
        setDomainVisitError('');
      }

      if (event.key === 'Escape' && isReclassifyDialogOpen && !reclassifying) {
        setIsReclassifyDialogOpen(false);
        setSelectedReclassificationCategory(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDomainVisitDialogOpen, isReclassifyDialogOpen, reclassifying, savingDomainVisitPreference]);

  useEffect(() => {
    if (!isMoreActionsMenuOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (!moreActionsRef.current?.contains(event.target as Node)) {
        setIsMoreActionsMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isMoreActionsMenuOpen]);

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

  function openFindingUrlInNewTab(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleVisitClick(event: React.MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation();

    if (!finding.url) {
      return;
    }

    if (!shouldWarnBeforeDomainVisit) {
      return;
    }

    event.preventDefault();
    setDomainVisitError('');
    setSkipDomainVisitWarningForFuture(false);
    setIsDomainVisitDialogOpen(true);
  }

  async function handleConfirmDomainVisit() {
    if (!finding.url || savingDomainVisitPreference) {
      return;
    }

    setSavingDomainVisitPreference(true);
    setDomainVisitError('');

    try {
      if (skipDomainVisitWarningForFuture && user?.preferences?.skipDomainRegistrationVisitWarning !== true) {
        const response = await fetch('/api/settings/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            skipDomainRegistrationVisitWarning: true,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? 'Failed to save setting');
        }

        await refreshSession();
      }

      openFindingUrlInNewTab(finding.url);
      setIsDomainVisitDialogOpen(false);
      setSkipDomainVisitWarningForFuture(false);
    } catch (error) {
      setDomainVisitError(error instanceof Error ? error.message : 'An unexpected error occurred.');
    } finally {
      setSavingDomainVisitPreference(false);
    }
  }

  async function handleAddressToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onAddressToggle || addressing) return;
    setAddressing(true);
    try {
      await onAddressToggle(finding, !isAddressed);
    } finally {
      setAddressing(false);
    }
  }

  async function handleConfirmReclassification() {
    if (!onReclassify || !selectedReclassificationCategory || reclassifying || selectedReclassificationCategory === currentCategory) return;

    setReclassifying(true);
    try {
      await onReclassify(finding, selectedReclassificationCategory);
      setIsReclassifyDialogOpen(false);
      setSelectedReclassificationCategory(null);
    } finally {
      setReclassifying(false);
    }
  }

  async function handleBookmarkToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onBookmarkUpdate || bookmarking) return;
    const nextIsBookmarked = !isBookmarked;
    setBookmarking(true);
    try {
      await onBookmarkUpdate(finding, { isBookmarked: nextIsBookmarked });
    } finally {
      setBookmarking(false);
    }
  }

  function openNoteEditor(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onNoteUpdate) return;
    setNoteDraft(finding.bookmarkNote ?? '');
    setEditingNote(true);
  }

  async function saveNote(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onNoteUpdate || savingNote) return;
    setSavingNote(true);
    try {
      await onNoteUpdate(finding, noteDraft);
      setEditingNote(false);
    } finally {
      setSavingNote(false);
    }
  }

  async function deleteNote(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onNoteUpdate || savingNote) return;
    setSavingNote(true);
    try {
      await onNoteUpdate(finding, null);
      setNoteDraft('');
      setEditingNote(false);
    } finally {
      setSavingNote(false);
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

  function handleSelectionToggle() {
    onSelectionChange?.(finding, !isSelected);
  }

  function handleCardClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!onSelectionChange) return;

    // Don't toggle selection if the user is highlighting text
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    if (shouldIgnoreCardSelectionClick(event.target)) return;
    handleSelectionToggle();
  }

  return (
    <>
      <div
        onClick={handleCardClick}
        className={cn(
          'border-b border-gray-100 p-0 pb-3 last:border-b-0 sm:border-b-0 sm:p-5 sm:rounded-xl sm:border transition-all duration-200',
          onSelectionChange ? 'cursor-pointer' : undefined,
          isSelected
            ? 'sm:border-brand-500 sm:ring-1 sm:ring-brand-500 bg-brand-50/30'
            : muted
              ? 'sm:bg-white sm:border-gray-200 opacity-75'
              : 'sm:bg-white sm:border-gray-200 sm:hover:border-gray-300',
          className,
        )}
      >
        {/* Source icon */}
        <div className="flex items-start gap-3 sm:gap-5">
          <div className="flex flex-col items-center gap-2 flex-shrink-0">
            <Tooltip content={src.label}>
              <span
                role="img"
                aria-label={src.label}
                className={cn(
                  'inline-flex p-2 sm:p-3 rounded-lg',
                  muted ? 'bg-gray-100 text-gray-400' : cn(src.bgClass, src.textClass),
                )}
              >
                <ScanSourceIcon source={finding.source} className="h-5 w-5 sm:h-6 sm:w-6" />
              </span>
            </Tooltip>
            {onSelectionChange && (
              <SelectionCheckbox
                checked={isSelected}
                onToggle={handleSelectionToggle}
              />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Title row — stacks on mobile, side-by-side on sm+ */}
            <div className="mb-2.5 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h4
                    className={cn(
                      'font-semibold text-base',
                      muted ? 'text-gray-500' : 'text-gray-900',
                    )}
                  >
                    {renderHighlightedText(finding.title, highlightQuery)}
                  </h4>
                  {!isFalsePositive && (
                    <Tooltip content={severityMeta.label}>
                      <span
                        role="img"
                        aria-label={severityMeta.label}
                        className={cn(
                          'hidden sm:inline-flex items-center justify-center rounded-md p-1',
                          muted ? 'text-gray-400' : severityMeta.className,
                        )}
                      >
                        <SeverityIcon className="w-4 h-4" />
                      </span>
                    </Tooltip>
                  )}
                </div>
                {domainLabel && (
                  <div className="min-w-0">
                    {isDomainLabelTruncated ? (
                      <Tooltip
                        content={domainLabel}
                        contentClassName="max-w-sm whitespace-normal break-all"
                      >
                        <span
                          className={cn(
                            'inline-block max-w-full cursor-help text-xs leading-4',
                            muted ? 'text-gray-400' : 'text-gray-500',
                          )}
                        >
                          {truncatedDomainLabel}
                        </span>
                      </Tooltip>
                    ) : (
                      <span
                        className={cn(
                          'inline-block max-w-full text-xs leading-4',
                          muted ? 'text-gray-400' : 'text-gray-500',
                        )}
                      >
                        {truncatedDomainLabel}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
              {finding.url && (
                <Tooltip content="Visit">
                  <a
                    href={finding.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Visit"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition"
                    onClick={handleVisitClick}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </Tooltip>
              )}

              {/* Secondary actions — always visible on sm+, hidden on mobile in favour of the kebab menu below */}
              <div className="hidden sm:flex items-center gap-2.5">
                {onReclassify && !isAddressed && (
                  isReclassifyDialogOpen ? (
                    <button
                      type="button"
                      disabled={reclassifying}
                      aria-label="Reclassify"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition disabled:opacity-60"
                    >
                      {reclassifying ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Crosshair className="w-3.5 h-3.5" />
                      )}
                    </button>
                  ) : (
                    <Tooltip content="Reclassify">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedReclassificationCategory(currentCategory);
                          setIsReclassifyDialogOpen(true);
                        }}
                        disabled={reclassifying}
                        aria-label="Reclassify"
                        className={cn(
                          'inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:opacity-60',
                          'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                        )}
                      >
                        {reclassifying ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Crosshair className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </Tooltip>
                  )
                )}
                {!isFalsePositive && !isAddressed && onIgnoreToggle && (
                  <Tooltip content={isIgnored ? 'Un-ignore' : 'Ignore'}>
                    <button
                      type="button"
                      onClick={handleIgnoreToggle}
                      disabled={ignoring}
                      aria-label={isIgnored ? 'Un-ignore' : 'Ignore'}
                      className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:opacity-60',
                        isIgnored
                          ? 'bg-gray-900 text-white border-transparent hover:bg-black'
                          : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                      )}
                    >
                      {ignoring ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isIgnored ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )}
                {!isFalsePositive && !isIgnored && onAddressToggle && (
                  <Tooltip content={isAddressed ? 'Mark as unaddressed' : 'Mark as addressed'}>
                    <button
                      type="button"
                      onClick={handleAddressToggle}
                      disabled={addressing}
                      aria-label={isAddressed ? 'Mark as unaddressed' : 'Mark as addressed'}
                      className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:opacity-60',
                        isAddressed
                          ? 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                          : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                      )}
                    >
                      {addressing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isAddressed ? (
                        <X className="w-3.5 h-3.5" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )}
                {onNoteUpdate && (
                  <Tooltip content={hasNote ? 'Edit note' : 'Add note'}>
                    <button
                      type="button"
                      onClick={openNoteEditor}
                      disabled={savingNote}
                      aria-label={hasNote ? 'Edit note' : 'Add note'}
                      className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:opacity-60',
                        hasNote
                          ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
                          : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                      )}
                    >
                      {savingNote ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Pencil className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )}
              </div>

              {/* Bookmark — always visible on all screen sizes */}
              {onBookmarkUpdate && (
                <Tooltip content={isBookmarked ? 'Unbookmark' : 'Bookmark'}>
                  <button
                    type="button"
                    onClick={handleBookmarkToggle}
                    disabled={bookmarking}
                    aria-label={isBookmarked ? 'Unbookmark' : 'Bookmark'}
                    className={cn(
                      'inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:opacity-60',
                      isBookmarked
                        ? 'bg-brand-600 text-white border-transparent hover:bg-brand-700'
                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900',
                    )}
                  >
                    {bookmarking ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Bookmark className="w-3.5 h-3.5" />
                    )}
                  </button>
                </Tooltip>
              )}

              {/* Mobile-only kebab menu for secondary actions */}
              {(onReclassify || onIgnoreToggle || onAddressToggle || onNoteUpdate) && (
                <div ref={moreActionsRef} className="relative sm:hidden">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMoreActionsMenuOpen((open) => !open);
                    }}
                    aria-label="More actions"
                    aria-expanded={isMoreActionsMenuOpen}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-900"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>

                  {isMoreActionsMenuOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1 min-w-[10.5rem] overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-xl">
                      {onReclassify && !isAddressed && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsMoreActionsMenuOpen(false);
                            setSelectedReclassificationCategory(currentCategory);
                            setIsReclassifyDialogOpen(true);
                          }}
                          disabled={reclassifying}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          <Crosshair className="w-4 h-4 flex-shrink-0" />
                          Reclassify
                        </button>
                      )}
                      {!isFalsePositive && !isAddressed && onIgnoreToggle && (
                        <button
                          type="button"
                          onClick={(e) => {
                            void handleIgnoreToggle(e);
                            setIsMoreActionsMenuOpen(false);
                          }}
                          disabled={ignoring}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          {isIgnored ? <Eye className="w-4 h-4 flex-shrink-0" /> : <EyeOff className="w-4 h-4 flex-shrink-0" />}
                          {isIgnored ? 'Un-ignore' : 'Ignore'}
                        </button>
                      )}
                      {!isFalsePositive && !isIgnored && onAddressToggle && (
                        <button
                          type="button"
                          onClick={(e) => {
                            void handleAddressToggle(e);
                            setIsMoreActionsMenuOpen(false);
                          }}
                          disabled={addressing}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          {isAddressed ? <X className="w-4 h-4 flex-shrink-0" /> : <Check className="w-4 h-4 flex-shrink-0" />}
                          {isAddressed ? 'Mark as unaddressed' : 'Mark as addressed'}
                        </button>
                      )}
                      {onNoteUpdate && (
                        <button
                          type="button"
                          onClick={(e) => {
                            openNoteEditor(e);
                            setIsMoreActionsMenuOpen(false);
                          }}
                          disabled={savingNote}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          <Pencil className="w-4 h-4 flex-shrink-0" />
                          {hasNote ? 'Edit note' : 'Add note'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              </div>
            </div>

            {finding.theme && (
              <div className="mb-3 hidden flex-wrap items-center gap-2 text-[11px] text-gray-500 sm:flex">
                {finding.theme && (
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5">
                    <span className="text-gray-700">
                      {renderHighlightedText(finding.theme, highlightQuery)}
                    </span>
                  </span>
                )}
              </div>
            )}

            {finding.url && shouldShowMatchedUrl && (
              <div className="mb-4 flex items-start gap-2 text-xs text-gray-500 break-all bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                <span className="hidden sm:inline font-semibold text-gray-700 select-none uppercase tracking-wider text-[10px] mt-0.5">URL</span>
                <a
                  href={finding.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:text-brand-700 hover:underline underline-offset-2 transition"
                  onClick={(e) => e.stopPropagation()}
                >
                  {renderHighlightedText(finding.url, highlightQuery)}
                </a>
              </div>
            )}

            {/* AI analysis box */}
            <div className="mb-3 rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-4 border-l-2 border-l-brand-500">
              <div className="flex items-start gap-3">
                <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-500" />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700/80">
                    AI analysis
                  </p>
                  <p className="mt-1 text-sm leading-6 text-gray-700">
                    {renderHighlightedText(finding.llmAnalysis, highlightQuery)}
                  </p>
                </div>
              </div>
            </div>

            {(hasNote || editingNote) && (
              <div className="mb-3 rounded-lg border border-brand-100 bg-brand-50/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <StickyNote className="w-4 h-4 text-brand-600 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-brand-900">Note</p>
                      {!editingNote && hasNote && (
                        <p className="mt-1 text-xs sm:text-sm text-brand-900 whitespace-pre-wrap break-words">
                          {finding.bookmarkNote}
                        </p>
                      )}
                    </div>
                  </div>
                  {onNoteUpdate && !editingNote && hasNote && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={openNoteEditor}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 transition"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit note
                      </button>
                      <button
                        type="button"
                        onClick={deleteNote}
                        disabled={savingNote}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 transition disabled:opacity-60"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete note
                      </button>
                    </div>
                  )}
                </div>

                {editingNote && onNoteUpdate && (
                  <div className="mt-3">
                    <textarea
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      rows={3}
                      maxLength={2000}
                      placeholder="Add a note..."
                      className="w-full rounded-lg border border-brand-100 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-[11px] text-brand-800/70">
                        {noteDraft.trim().length}/2000
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingNote(false);
                            setNoteDraft(finding.bookmarkNote ?? '');
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-white transition"
                        >
                          <X className="w-3.5 h-3.5" />
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveNote}
                          disabled={savingNote}
                          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 transition disabled:opacity-60"
                        >
                          {savingNote ? (
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
                  icon={Sparkles}
                  label="LLM analysis prompt"
                  onOpen={ensureDebugFinding}
                  loading={debugLoading}
                  error={debugError}
                >
                  {debugFinding?.llmAnalysisPrompt
                    ? debugFinding.llmAnalysisPrompt
                    : '(not available — AI analysis may have failed before the request was sent, or this is a legacy finding)'}
                </ExpandableSection>

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

      {isMounted && isReclassifyDialogOpen && onReclassify && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-gray-950/70 px-4 py-4"
          onClick={() => {
            if (!reclassifying) {
              setIsReclassifyDialogOpen(false);
              setSelectedReclassificationCategory(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`reclassify-finding-title-${finding.id}`}
            aria-describedby={`reclassify-finding-description-${finding.id}`}
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand-100">
                <Crosshair className="h-5 w-5 text-brand-700" />
              </div>
              <div className="min-w-0">
                <h2 id={`reclassify-finding-title-${finding.id}`} className="text-lg font-semibold text-gray-900">
                  Reclassify this finding?
                </h2>
                <p id={`reclassify-finding-description-${finding.id}`} className="mt-2 text-sm leading-6 text-gray-600">
                  Choose the category you want to move this finding into.
                  {finding.url ? ' Matching entries for the same URL will be updated too.' : ''}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {(['high', 'medium', 'low', 'non-hit'] as const).map((category) => {
                const meta = categoryConfig[category];
                const CategoryOptionIcon = meta.icon;
                const isSelected = selectedReclassificationCategory === category;

                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setSelectedReclassificationCategory(category)}
                    className={cn(
                      'rounded-xl border px-4 py-3 text-left transition',
                      isSelected
                        ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className={cn('inline-flex items-center gap-2 text-sm font-semibold', meta.className)}>
                        <CategoryOptionIcon className="w-4 h-4" />
                        {meta.label}
                      </span>
                      {isSelected && <Check className="w-4 h-4 text-brand-600" />}
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      {meta.description}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={reclassifying}
                onClick={() => {
                  setIsReclassifyDialogOpen(false);
                  setSelectedReclassificationCategory(null);
                }}
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 disabled:opacity-60"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedReclassificationCategory || selectedReclassificationCategory === currentCategory || reclassifying}
                onClick={handleConfirmReclassification}
                className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {reclassifying ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Crosshair className="w-4 h-4" />
                )}
                Save category
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {isMounted && isDomainVisitDialogOpen && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-gray-950/70 px-4 py-4"
          onClick={() => {
            if (!savingDomainVisitPreference) {
              setIsDomainVisitDialogOpen(false);
              setSkipDomainVisitWarningForFuture(false);
              setDomainVisitError('');
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`domain-visit-title-${finding.id}`}
            aria-describedby={`domain-visit-description-${finding.id}`}
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="min-w-0">
                <h2 id={`domain-visit-title-${finding.id}`} className="text-lg font-semibold text-gray-900">
                  Continue to this domain?
                </h2>
                <p id={`domain-visit-description-${finding.id}`} className="mt-2 text-sm leading-6 text-gray-600">
                  Some malicious domains can host inappropriate content (for example, adult material). Are you sure you want to continue?
                </p>
              </div>
            </div>

            <label className="mt-5 ml-0 flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 sm:ml-[3.75rem]">
              <input
                type="checkbox"
                checked={skipDomainVisitWarningForFuture}
                disabled={savingDomainVisitPreference}
                onChange={(event) => setSkipDomainVisitWarningForFuture(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-gray-700">Don&apos;t show me this again</span>
            </label>

            {domainVisitError && (
              <p className="mt-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                {domainVisitError}
              </p>
            )}

            <div className="mt-6 ml-0 flex justify-end gap-3 sm:ml-[3.75rem]">
              <button
                type="button"
                disabled={savingDomainVisitPreference}
                onClick={() => {
                  setIsDomainVisitDialogOpen(false);
                  setSkipDomainVisitWarningForFuture(false);
                  setDomainVisitError('');
                }}
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 disabled:opacity-60"
              >
                No
              </button>
              <button
                type="button"
                disabled={savingDomainVisitPreference}
                onClick={() => void handleConfirmDomainVisit()}
                className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {savingDomainVisitPreference ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                Yes
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
