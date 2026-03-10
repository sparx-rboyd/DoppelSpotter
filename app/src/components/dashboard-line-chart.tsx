'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatInteger, formatScanDate } from '@/lib/utils';
import type { DashboardTimeline } from '@/lib/types';

type DashboardLineChartProps = {
  data: DashboardTimeline | null;
  emptyMessage: string;
  expanded?: boolean;
  visibleSeriesKeys?: string[];
  selectionEmptyMessage?: string;
};

type DashboardLineChartTooltipEntry = {
  color?: string;
  dataKey?: string | number;
  name?: string;
  payload?: {
    fullLabel?: string;
  };
  value?: number | string;
};

type DashboardLineChartTooltipProps = {
  active?: boolean;
  label?: string;
  payload?: readonly DashboardLineChartTooltipEntry[];
};

type DashboardTimelineTimestampLike =
  | DashboardTimeline['points'][number]['startedAt']
  | { _seconds: number; _nanoseconds?: number }
  | { seconds: number; nanoseconds?: number };

function formatTimelineAxisLabel(value: DashboardTimeline['points'][number]['startedAt']): string {
  try {
    const timestamp = value as DashboardTimelineTimestampLike;
    const date = typeof (timestamp as { toDate?: unknown }).toDate === 'function'
      ? (timestamp as { toDate(): Date }).toDate()
      : '_seconds' in timestamp
        ? new Date(timestamp._seconds * 1000)
        : 'seconds' in timestamp
          ? new Date(timestamp.seconds * 1000)
          : new Date();

    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '—';
  }
}

function DashboardLineChartTooltip({ active, payload, label }: DashboardLineChartTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const entries = [...payload]
    .map((entry) => ({
      ...entry,
      numericValue: Number(entry.value) || 0,
    }))
    .filter((entry) => entry.numericValue > 0)
    .sort((left, right) => right.numericValue - left.numericValue || String(left.name).localeCompare(String(right.name)));

  const total = entries.reduce((sum, entry) => sum + entry.numericValue, 0);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none min-w-[12rem] rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-lg">
      <p className="text-sm font-semibold text-gray-900">{label}</p>
      <p className="mt-1 text-[11px] text-gray-500">{formatInteger(total)} actionable finding{total !== 1 ? 's' : ''}</p>
      <div className="mt-2.5 space-y-1.5">
        {entries.map((entry) => (
          <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-gray-600">{entry.name}</span>
            </div>
            <span className="font-medium text-gray-900">{formatInteger(entry.numericValue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardLineChart({
  data,
  emptyMessage,
  expanded = false,
  visibleSeriesKeys,
  selectionEmptyMessage = 'Select at least one series to display.',
}: DashboardLineChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollCueState, setScrollCueState] = useState({
    hasOverflow: false,
    showLeft: false,
    showRight: false,
  });

  const updateScrollCues = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const hasOverflow = container.scrollWidth - container.clientWidth > 2;
    const showLeft = hasOverflow && container.scrollLeft > 2;
    const showRight = hasOverflow
      && container.scrollLeft + container.clientWidth < container.scrollWidth - 2;

    setScrollCueState((current) => (
      current.hasOverflow === hasOverflow
      && current.showLeft === showLeft
      && current.showRight === showRight
        ? current
        : { hasOverflow, showLeft, showRight }
    ));
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(updateScrollCues);
    window.addEventListener('resize', updateScrollCues);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateScrollCues);
    };
  }, [data, updateScrollCues]);

  if (!data || data.series.length === 0 || data.points.length === 0) {
    return (
      <div className={`flex ${expanded ? 'min-h-full h-full' : 'min-h-[20rem]'} items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/70 px-6 text-center text-sm text-gray-500`}>
        {emptyMessage}
      </div>
    );
  }

  const visibleSeries = visibleSeriesKeys
    ? data.series.filter((series) => visibleSeriesKeys.includes(series.key))
    : data.series;

  if (visibleSeries.length === 0) {
    return (
      <div className={`flex ${expanded ? 'min-h-full h-full' : 'min-h-[20rem]'} items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/70 px-6 text-center text-sm text-gray-500`}>
        {selectionEmptyMessage}
      </div>
    );
  }

  const chartData = data.points.map((point) => {
    const row: Record<string, string | number> = {
      scanId: point.scanId,
      label: formatTimelineAxisLabel(point.startedAt),
      fullLabel: formatScanDate(point.startedAt),
    };

    for (const series of visibleSeries) {
      row[series.key] = point.values[series.key] ?? 0;
    }

    return row;
  });

  const chartWidth = Math.max(expanded ? 960 : 640, chartData.length * (expanded ? 120 : 96));
  const chartHeight = expanded ? 620 : 360;
  const gradientClassName = expanded
    ? 'from-white via-white/90'
    : 'from-white via-white/95';

  return (
    <div className={`relative ${expanded ? 'h-full min-h-0' : ''}`}>
      <div className={`relative ${expanded ? 'h-full min-h-0' : ''}`}>
        <div
          ref={scrollRef}
          className={`overflow-x-auto select-none ${expanded ? 'h-full min-h-0 pb-3' : 'pb-2'}`}
          onScroll={updateScrollCues}
        >
          <div
            style={{
              width: expanded ? '100%' : chartWidth,
              minWidth: expanded ? chartWidth : undefined,
              height: chartHeight,
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: expanded ? 8 : 0, bottom: expanded ? 72 : 48 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={expanded ? 72 : 56}
                  tick={{ fill: '#64748b', fontSize: expanded ? 13 : 12 }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: '#64748b', fontSize: 12 }}
                />
                <Tooltip
                  cursor={{ stroke: 'rgba(2, 132, 199, 0.24)', strokeWidth: 1.5 }}
                  content={({ active, payload, label }) => (
                    <DashboardLineChartTooltip
                      active={active}
                      payload={payload as readonly DashboardLineChartTooltipEntry[] | undefined}
                      label={payload?.[0]?.payload?.fullLabel ?? (typeof label === 'string' ? label : undefined)}
                    />
                  )}
                />
                {visibleSeries.map((series) => (
                  <Line
                    key={series.key}
                    type="linear"
                    dataKey={series.key}
                    name={series.label}
                    stroke={series.color}
                    strokeWidth={2.5}
                    strokeDasharray={series.strokeDasharray}
                    dot={{ r: 2.5, strokeWidth: 0, fill: series.color }}
                    activeDot={{ r: 5, strokeWidth: 0, fill: series.color }}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {scrollCueState.hasOverflow && (
          <>
            {scrollCueState.showLeft && (
              <div className={`pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-start bg-gradient-to-r ${gradientClassName} to-transparent`}>
                <ChevronLeft className="ml-2 h-4 w-4 text-gray-300" />
              </div>
            )}
            {scrollCueState.showRight && (
              <div className={`pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l ${gradientClassName} to-transparent`}>
                <ChevronRight className="mr-2 h-4 w-4 text-gray-300" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
