'use client';

import { InfoTooltip } from '@/components/ui/tooltip';
import {
  MAX_AI_DEEP_SEARCHES,
  MAX_SEARCH_RESULT_PAGES,
  MIN_AI_DEEP_SEARCHES,
  MIN_SEARCH_RESULT_PAGES,
} from '@/lib/brands';

type BrandScanTuningFieldsProps = {
  searchResultPages: number;
  onSearchResultPagesChange: (value: number) => void;
  allowAiDeepSearches: boolean;
  onAllowAiDeepSearchesChange: (value: boolean) => void;
  maxAiDeepSearches: number;
  onMaxAiDeepSearchesChange: (value: number) => void;
};

type SliderFieldProps = {
  id: string;
  label: string;
  tooltip: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  minLabel: string;
  minSubtext: string;
  maxLabel: string;
  maxSubtext: string;
  labelTone?: 'default' | 'subtle';
};

function SliderField({
  id,
  label,
  tooltip,
  value,
  min,
  max,
  onChange,
  minLabel,
  minSubtext,
  maxLabel,
  maxSubtext,
  labelTone = 'default',
}: SliderFieldProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className={`inline-flex items-center gap-1.5 font-medium ${
          labelTone === 'subtle' ? 'text-xs text-gray-500' : 'text-sm text-gray-700'
        }`}
      >
        {label}
        <InfoTooltip content={tooltip} />
      </label>
      <div className="mt-3">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{minLabel}</p>
            <p className="text-xs text-gray-400">{minSubtext}</p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-sm text-gray-500">{maxLabel}</p>
            <p className="text-xs text-gray-400">{maxSubtext}</p>
          </div>
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-4 w-full accent-brand-600"
        />
      </div>
    </div>
  );
}

export function BrandScanTuningFields({
  searchResultPages,
  onSearchResultPagesChange,
  allowAiDeepSearches,
  onAllowAiDeepSearchesChange,
  maxAiDeepSearches,
  onMaxAiDeepSearchesChange,
}: BrandScanTuningFieldsProps) {
  return (
    <div className="space-y-4 border-t border-gray-100 pt-6">
      <div className="pb-4">
        <SliderField
          id="search-result-pages"
          label="Search depth"
          tooltip="Controls how extensively DoppelSpotter searches for potential matches. Google-backed scan types like Web search, Reddit, TikTok, YouTube, Facebook, Instagram, and Telegram channels use this as search-result depth, Domain registrations map it to result volume from 100 to 500 domains, GitHub repos and X map it to result volume from 50 to 250 items, and Discord servers map it to an Apify spend cap from $0.20 to $0.60 per run."
          value={searchResultPages}
          min={MIN_SEARCH_RESULT_PAGES}
          max={MAX_SEARCH_RESULT_PAGES}
          onChange={onSearchResultPagesChange}
          minLabel="Fewer results"
          minSubtext="Faster"
          maxLabel="More results"
          maxSubtext="Slower"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Allow AI analysis to request deeper Google-backed searches
            <InfoTooltip content="Allows AI analysis to request follow-up searches when it spots something concerning on Google-backed scan types such as Web search, Reddit, TikTok, YouTube, Facebook, Instagram, and Telegram channels. Domain registrations, Discord servers, GitHub repos, and X do not support deep search." />
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowAiDeepSearches}
          aria-label="Allow AI analysis to request deeper Google-backed searches"
          onClick={() => onAllowAiDeepSearchesChange(!allowAiDeepSearches)}
          className={`inline-flex items-center gap-2 rounded-md text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            allowAiDeepSearches ? 'text-brand-700' : 'text-gray-600'
          }`}
        >
          <span>{allowAiDeepSearches ? 'On' : 'Off'}</span>
          <span
            className={`relative inline-flex h-6 w-11 rounded-full transition ${
              allowAiDeepSearches ? 'bg-brand-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                allowAiDeepSearches ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </span>
        </button>
      </div>

      {allowAiDeepSearches && (
        <div className="-mx-6 border-t border-gray-100 bg-gray-50 px-6 py-4">
          <SliderField
            id="max-ai-deep-searches"
            label="Google deep search breadth"
            tooltip="Controls how many follow-up searches AI analysis may request when it spots something concerning on Google-backed scan types. More deep searches increase coverage, but scans will be slower."
            value={maxAiDeepSearches}
            min={MIN_AI_DEEP_SEARCHES}
            max={MAX_AI_DEEP_SEARCHES}
            onChange={onMaxAiDeepSearchesChange}
            minLabel="Fewer deep searches"
            minSubtext="Faster"
            maxLabel="More deep searches"
            maxSubtext="Slower"
            labelTone="subtle"
          />
        </div>
      )}
    </div>
  );
}
