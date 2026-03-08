'use client';

import type { BrandScanSources } from '@/lib/types';

type BrandScanSourceFieldsProps = {
  value: BrandScanSources;
  onChange: (value: BrandScanSources) => void;
  error?: string;
};

const SOURCE_ROWS: Array<{
  key: keyof BrandScanSources;
  label: string;
}> = [
  {
    key: 'google',
    label: 'Web search',
  },
  {
    key: 'reddit',
    label: 'Reddit',
  },
  {
    key: 'tiktok',
    label: 'TikTok',
  },
  {
    key: 'youtube',
    label: 'YouTube',
  },
  {
    key: 'facebook',
    label: 'Facebook',
  },
  {
    key: 'instagram',
    label: 'Instagram',
  },
];

export function BrandScanSourceFields({ value, onChange, error }: BrandScanSourceFieldsProps) {
  function toggleSource(key: keyof BrandScanSources) {
    onChange({
      ...value,
      [key]: !value[key],
    });
  }

  return (
    <div className="space-y-4">
      {SOURCE_ROWS.map((source) => {
        const enabled = value[source.key];
        return (
          <div key={source.key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-700">{source.label}</div>
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
