'use client';

import { useMemo } from 'react';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  formatScanScheduleFrequency,
  getSupportedTimeZones,
  parseScheduleStart,
} from '@/lib/scan-schedules';
import type { BrandScanScheduleInput } from '@/lib/types';

type BrandScanScheduleFieldsProps = {
  value: BrandScanScheduleInput;
  onChange: (nextValue: BrandScanScheduleInput) => void;
};

function ordinalSuffix(value: number): string {
  const modulo = value % 100;
  if (modulo >= 11 && modulo <= 13) return 'th';

  switch (value % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

function buildScheduleSummary(value: BrandScanScheduleInput): string {
  if (!value.enabled) {
    return 'Scheduling is off. Manual scans can still be run at any time.';
  }

  const start = parseScheduleStart(value);
  if (!start.isValid) {
    return 'Choose a valid start date, time, and timezone to enable scheduled scans.';
  }

  const time = start.toFormat('HH:mm');
  const zone = value.timeZone;

  switch (value.frequency) {
    case 'daily':
      return `Runs every day at ${time} (${zone}).`;
    case 'weekly':
      return `Runs every ${start.toFormat('cccc')} at ${time} (${zone}).`;
    case 'fortnightly':
      return `Runs every second ${start.toFormat('cccc')} at ${time} (${zone}), anchored from the selected start date.`;
    case 'monthly':
      return `Runs on the ${start.day}${ordinalSuffix(start.day)} of each month at ${time} (${zone}). Shorter months use the last day.`;
  }
}

export function BrandScanScheduleFields({
  value,
  onChange,
}: BrandScanScheduleFieldsProps) {
  const timeZones = useMemo(() => getSupportedTimeZones(), []);
  const summary = buildScheduleSummary(value);

  function updateValue(patch: Partial<BrandScanScheduleInput>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Scheduled scans
            <InfoTooltip content="Schedule recurring scans for this brand. Manual scans remain available even when scheduling is enabled." />
          </div>
          <p className="text-sm text-gray-500">
            {summary}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value.enabled}
          aria-label="Enable scheduled scans"
          onClick={() => updateValue({ enabled: !value.enabled })}
          className={`inline-flex items-center gap-3 rounded-full border px-3 py-2 text-sm font-medium transition ${
            value.enabled
              ? 'border-brand-600 bg-brand-50 text-brand-700'
              : 'border-gray-300 bg-gray-50 text-gray-600'
          }`}
        >
          <span>{value.enabled ? 'On' : 'Off'}</span>
          <span
            className={`relative inline-flex h-6 w-11 rounded-full transition ${
              value.enabled ? 'bg-brand-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${
                value.enabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </span>
        </button>
      </div>

      <div className={cn(
        'grid gap-4 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-2',
        !value.enabled && 'opacity-60',
      )}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="schedule-frequency" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Frequency
            <InfoTooltip content="The selected start date anchors weekly, fortnightly, and monthly repeats." />
          </label>
          <select
            id="schedule-frequency"
            value={value.frequency}
            disabled={!value.enabled}
            onChange={(event) => updateValue({ frequency: event.target.value as BrandScanScheduleInput['frequency'] })}
            className="brand-form-input w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:cursor-not-allowed"
          >
            {(['daily', 'weekly', 'fortnightly', 'monthly'] as const).map((frequency) => (
              <option key={frequency} value={frequency}>
                {formatScanScheduleFrequency(frequency)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="schedule-timezone" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Timezone
            <InfoTooltip content="Scheduled scans stay pinned to this local timezone, including through daylight saving changes." />
          </label>
          <select
            id="schedule-timezone"
            value={value.timeZone}
            disabled={!value.enabled}
            onChange={(event) => updateValue({ timeZone: event.target.value })}
            className="brand-form-input w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:cursor-not-allowed"
          >
            {timeZones.map((timeZone) => (
              <option key={timeZone} value={timeZone}>
                {timeZone}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="schedule-start-date" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Start date
            <InfoTooltip content="The first local date used to anchor the repeating schedule." />
          </label>
          <input
            id="schedule-start-date"
            type="date"
            value={value.startDate}
            disabled={!value.enabled}
            onChange={(event) => updateValue({ startDate: event.target.value })}
            className="brand-form-input w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="schedule-start-time" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
            Time
            <InfoTooltip content="The same local time is reused for each scheduled run." />
          </label>
          <input
            id="schedule-start-time"
            type="time"
            value={value.startTime}
            disabled={!value.enabled}
            onChange={(event) => updateValue({ startTime: event.target.value })}
            className="brand-form-input w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:cursor-not-allowed"
          />
        </div>
      </div>
    </div>
  );
}
