'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Globe,
  Instagram,
  Twitter,
  Facebook,
  Search,
  Smartphone,
  BookMarked,
  Bot,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Code2,
  MessageSquare,
  EyeOff,
  Eye,
  Loader2,
} from 'lucide-react';
import { type Finding, type FindingSource } from '@/lib/types';
import { SeverityBadge } from './severity-badge';
import { cn } from '@/lib/utils';

interface FindingCardProps {
  finding: Finding;
  className?: string;
  /**
   * Called when the user toggles the ignored state.
   * Receives the full finding (so the parent has access to the URL for URL-scoped updates)
   * and the new desired ignored state. Should return a promise that resolves on success.
   */
  onIgnoreToggle?: (finding: Finding, isIgnored: boolean) => Promise<void>;
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
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
      {open && (
        <pre className="p-3 text-xs text-gray-700 bg-white overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed max-h-80 overflow-y-auto border-t border-gray-200">
          {children}
        </pre>
      )}
    </div>
  );
}

export function FindingCard({ finding, className, onIgnoreToggle }: FindingCardProps) {
  const src = sourceConfig[finding.source] ?? sourceConfig.unknown;
  const Icon = src.icon;
  const isFalsePositive = finding.isFalsePositive === true;
  const isIgnored = finding.isIgnored === true;
  const muted = isFalsePositive || isIgnored;

  const searchParams = useSearchParams();
  const showDebug = searchParams.get('debug') === 'true';

  const [ignoring, setIgnoring] = useState(false);

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

  return (
    <div
      className={cn(
        'bg-white p-4 sm:p-5 rounded-xl border shadow-sm',
        muted
          ? 'border-gray-200 opacity-75'
          : 'border-gray-200 hover:border-brand-300 transition',
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
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h4
              className={cn(
                'font-semibold text-sm sm:text-base',
                muted ? 'text-gray-500' : 'text-gray-900',
              )}
            >
              {finding.title}
            </h4>
            {isIgnored ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                <EyeOff className="w-3 h-3" />
                Ignored
              </span>
            ) : isFalsePositive ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                Non-hit
              </span>
            ) : (
              <SeverityBadge severity={finding.severity} />
            )}
            {finding.url && (
              <a
                href={finding.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-600 hover:bg-brand-100 transition"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
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
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition',
                  isIgnored
                    ? 'bg-brand-50 text-brand-600 hover:bg-brand-100'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                )}
              >
                {ignoring ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : isIgnored ? (
                  <Eye className="w-3 h-3" />
                ) : (
                  <EyeOff className="w-3 h-3" />
                )}
                {isIgnored ? 'Un-ignore' : 'Ignore'}
              </button>
            )}
          </div>

          {/* AI analysis box */}
          <div className="bg-gray-50 rounded-lg p-2 sm:p-3 text-xs sm:text-sm text-gray-600 border border-gray-100 flex items-start gap-2 mb-3">
            <Bot className="w-4 h-4 text-brand-500 mt-0.5 flex-shrink-0" />
            <p>
              <strong>AI analysis:</strong>{' '}
              {finding.llmAnalysis}
            </p>
          </div>

          {/* Debug expandables — visible only when ?debug=true */}
          {showDebug && (
            <div className="space-y-1.5">
              <ExpandableSection icon={MessageSquare} label="Raw AI response">
                {finding.rawLlmResponse
                  ? (() => {
                      try {
                        return JSON.stringify(JSON.parse(finding.rawLlmResponse), null, 2);
                      } catch {
                        return finding.rawLlmResponse;
                      }
                    })()
                  : '(not available — AI analysis may have failed or this is a legacy finding)'}
              </ExpandableSection>

              <ExpandableSection icon={Code2} label="Raw actor data">
                {JSON.stringify(finding.rawData, null, 2)}
              </ExpandableSection>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
