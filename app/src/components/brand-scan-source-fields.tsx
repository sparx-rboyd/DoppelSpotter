'use client';

import {
  getFindingSourceLabel,
  SCAN_SOURCE_ORDER,
  sortScanSourcesByLabel,
  supportsSourceDeepSearch,
} from '@/lib/scan-sources';
import type { BrandScanSources } from '@/lib/types';
import { ScanSourceIcon } from './scan-source-icon';

type BrandScanSourceFieldsProps = {
  value: BrandScanSources;
  onChange: (value: BrandScanSources) => void;
  error?: string;
};

const SOURCE_ROWS: Array<{
  key: keyof BrandScanSources;
  label: string;
  supportsDeepSearch: boolean;
}> = sortScanSourcesByLabel(SCAN_SOURCE_ORDER).map((source) => ({
  key: source,
  label: getFindingSourceLabel(source),
  supportsDeepSearch: supportsSourceDeepSearch(source),
}));

export function BrandScanSourceFields({ value, onChange, error }: BrandScanSourceFieldsProps) {
  const enabledCount = SOURCE_ROWS.filter((source) => value[source.key]).length;
  const allEnabled = enabledCount === SOURCE_ROWS.length;
  const allDisabled = enabledCount === 0;

  function toggleSource(key: keyof BrandScanSources) {
    onChange({
      ...value,
      [key]: !value[key],
    });
  }

  function setAllSources(enabled: boolean) {
    onChange(
      SOURCE_ROWS.reduce<BrandScanSources>((nextValue, source) => {
        nextValue[source.key] = enabled;
        return nextValue;
      }, { ...value }),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {enabledCount} of {SOURCE_ROWS.length} enabled
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAllSources(true)}
            disabled={allEnabled}
            className="rounded-full border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:border-brand-200 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Turn all on
          </button>
          <button
            type="button"
            onClick={() => setAllSources(false)}
            disabled={allDisabled}
            className="rounded-full border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:border-brand-200 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Turn all off
          </button>
        </div>
      </div>
      {SOURCE_ROWS.map((source) => {
        const enabled = value[source.key];
        return (
          <div key={source.key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <ScanSourceIcon source={source.key} className="h-4 w-4 flex-shrink-0 text-gray-500" />
                <div className="truncate text-sm font-medium text-gray-700">{source.label}</div>
                {!source.supportsDeepSearch && (
                  <span className="inline-flex flex-shrink-0 items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    No deep search
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${source.label} scan`}
              onClick={() => toggleSource(source.key)}
              className={`inline-flex items-center gap-2 rounded-md text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                enabled ? 'text-brand-700' : 'text-gray-600'
              }`}
            >
              <span>{enabled ? 'On' : 'Off'}</span>
              <span
                className={`relative inline-flex h-6 w-11 rounded-full transition ${
                  enabled ? 'bg-brand-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                    enabled ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
          </div>
        );
      })}
      {error && (
        <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
