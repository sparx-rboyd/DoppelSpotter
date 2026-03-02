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
} from 'lucide-react';
import { type Finding, type FindingSource } from '@/lib/types';
import { SeverityBadge } from './severity-badge';
import { cn } from '@/lib/utils';

interface FindingCardProps {
  finding: Finding;
  className?: string;
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

export function FindingCard({ finding, className }: FindingCardProps) {
  const src = sourceConfig[finding.source] ?? sourceConfig.unknown;
  const Icon = src.icon;

  return (
    <div
      className={cn(
        'bg-white p-4 sm:p-5 rounded-xl border border-gray-200 shadow-sm',
        'flex items-start gap-3 sm:gap-5',
        'hover:border-brand-300 transition cursor-pointer',
        className,
      )}
    >
      {/* Source icon */}
      <div className={cn('p-2 sm:p-3 rounded-lg flex-shrink-0', src.bgClass, src.textClass)}>
        <Icon className="w-5 h-5 sm:w-6 sm:h-6" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h4 className="font-semibold text-gray-900 text-sm sm:text-base">
            {finding.title}
          </h4>
          <SeverityBadge severity={finding.severity} />
          <span className="text-xs text-gray-400 font-mono hidden sm:inline">
            via {finding.actorId}
          </span>
        </div>

        {/* Description */}
        <p className="text-xs sm:text-sm text-gray-500 mb-2">
          {finding.description}
          {finding.url && (
            <a
              href={finding.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 text-brand-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </p>

        {/* LLM analysis box */}
        <div className="bg-gray-50 rounded-lg p-2 sm:p-3 text-xs sm:text-sm text-gray-600 border border-gray-100 flex items-start gap-2">
          <Bot className="w-4 h-4 text-brand-500 mt-0.5 flex-shrink-0" />
          <p>
            <strong>LLM Analysis:</strong> {finding.llmAnalysis}
          </p>
        </div>
      </div>
    </div>
  );
}
