'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatInteger } from '@/lib/utils';
import type { DashboardBreakdownCategory, DashboardBreakdownRow } from '@/lib/types';

type DashboardStackedBarChartProps = {
  data: DashboardBreakdownRow[];
  emptyMessage: string;
  onSegmentClick?: (category: DashboardBreakdownCategory, row: DashboardBreakdownRow) => void;
  hiddenCategories?: DashboardBreakdownCategory[];
  expanded?: boolean;
};

type DashboardChartTooltipEntry = {
  color?: string;
  dataKey?: string | number;
  name?: string;
  value?: number | string;
};

type DashboardChartTooltipProps = {
  active?: boolean;
  label?: string;
  payload?: readonly DashboardChartTooltipEntry[];
};

type DashboardBarShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: DashboardBreakdownRow;
  value?: number | string | [number, number];
};

const chartSeries = [
  { key: 'high', label: 'High', color: '#dc2626', hoverColor: '#b91c1c' },
  { key: 'medium', label: 'Medium', color: '#d97706', hoverColor: '#b45309' },
  { key: 'low', label: 'Low', color: '#059669', hoverColor: '#047857' },
  { key: 'nonHit', label: 'Non-finding', color: '#cbd5e1', hoverColor: '#94a3b8' },
] as const;

function DashboardChartTooltip({ active, payload, label }: DashboardChartTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const total = payload.reduce((sum, item) => sum + (Number(item.value) || 0), 0);

  return (
    <div className="pointer-events-none min-w-[12rem] rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
      <p className="text-sm font-semibold text-gray-900">{label}</p>
      <p className="mt-1 text-xs text-gray-500">{formatInteger(total)} total finding{total !== 1 ? 's' : ''}</p>
      <div className="mt-3 space-y-2">
        {payload.map((entry) => {
          const value = Number(entry.value) || 0;
          if (value === 0) return null;

          return (
            <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-gray-600">{entry.name}</span>
              </div>
              <span className="font-medium text-gray-900">{formatInteger(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatAxisLabel(label: string): string {
  return label.length > 14 ? `${label.slice(0, 14)}…` : label;
}

export function DashboardStackedBarChart({
  data,
  emptyMessage,
  onSegmentClick,
  hiddenCategories = [],
  expanded = false,
}: DashboardStackedBarChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isChartPointerActive, setIsChartPointerActive] = useState(false);
  const [hoveredSegmentKey, setHoveredSegmentKey] = useState<string | null>(null);
  const [scrollCueState, setScrollCueState] = useState({
    hasOverflow: false,
    showLeft: false,
    showRight: false,
  });
  const visibleSeries = chartSeries.filter((series) => !hiddenCategories.includes(series.key));
  const visibleData = data
    .map((row) => {
      const nextRow: DashboardBreakdownRow = { ...row, total: 0 };

      for (const series of chartSeries) {
        if (hiddenCategories.includes(series.key)) {
          nextRow[series.key] = 0;
          continue;
        }

        nextRow.total += row[series.key];
      }

      return nextRow;
    })
    .filter((row) => row.total > 0);

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

  const clearChartHoverState = useCallback(() => {
    setIsChartPointerActive(false);
    setHoveredSegmentKey(null);
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(updateScrollCues);
    window.addEventListener('resize', updateScrollCues);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateScrollCues);
    };
  }, [visibleData.length, updateScrollCues]);

  if (visibleData.length === 0) {
    return (
      <div className={`flex ${expanded ? 'min-h-full h-full' : 'min-h-[20rem]'} items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/70 px-6 text-center text-sm text-gray-500`}>
        {emptyMessage}
      </div>
    );
  }

  const chartWidth = Math.max(expanded ? 920 : 520, visibleData.length * (expanded ? 118 : 92));
  const chartHeight = expanded ? 620 : 340;
  const gradientClassName = expanded
    ? 'from-white via-white/90'
    : 'from-white via-white/95';

  return (
    <div
      className={`relative ${expanded ? 'h-full min-h-0' : ''}`}
      onMouseLeave={clearChartHoverState}
    >
      <div
        ref={scrollRef}
        className={`overflow-x-auto select-none ${expanded ? 'h-full min-h-0 pb-3' : 'pb-2'}`}
        onScroll={updateScrollCues}
        onMouseLeave={clearChartHoverState}
      >
        <div style={{ width: chartWidth, height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={visibleData}
              margin={{ top: 8, right: 12, left: expanded ? 8 : 0, bottom: expanded ? 72 : 48 }}
              barGap={4}
              barCategoryGap={expanded ? 24 : 20}
              onMouseMove={() => {
                setIsChartPointerActive(true);
              }}
              onMouseLeave={clearChartHoverState}
            >
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
                tickFormatter={formatAxisLabel}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fill: '#64748b', fontSize: 12 }}
              />
              <Tooltip
                active={isChartPointerActive ? undefined : false}
                cursor={isChartPointerActive ? { fill: 'rgba(2, 132, 199, 0.08)' } : false}
                content={({ active, payload, label }) => (
                  <DashboardChartTooltip
                    active={isChartPointerActive && active}
                    payload={payload as readonly DashboardChartTooltipEntry[] | undefined}
                    label={typeof label === 'string' ? label : undefined}
                  />
                )}
              />
              <Legend
                verticalAlign="top"
                align="right"
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ paddingBottom: 18, fontSize: 12, color: '#64748b' }}
                formatter={(value) => (
                  <span className="text-[12px] text-slate-500">{value}</span>
                )}
              />
              {visibleSeries.map((series) => (
                <Bar
                  key={series.key}
                  dataKey={series.key}
                  name={series.label}
                  stackId="dashboard"
                  fill={series.color}
                  cursor={onSegmentClick ? 'pointer' : undefined}
                  shape={(shapeProps: DashboardBarShapeProps) => {
                    const {
                      x = 0,
                      y = 0,
                      width = 0,
                      height = 0,
                      fill,
                      payload,
                      value,
                    } = shapeProps;

                    if (width <= 0 || height <= 0) {
                      return null;
                    }

                    const segmentKey = `${payload?.label ?? 'unknown'}:${series.key}`;
                    const isHovered = hoveredSegmentKey === segmentKey;
                    const insetStrokeOffset = 1;
                    const innerX = x + insetStrokeOffset;
                    const innerY = y + insetStrokeOffset;
                    const innerWidth = Math.max(0, width - insetStrokeOffset * 2);
                    const innerHeight = Math.max(0, height - insetStrokeOffset * 2);

                    return (
                      <g
                        className={onSegmentClick ? 'cursor-pointer' : undefined}
                        onMouseEnter={() => setHoveredSegmentKey(segmentKey)}
                        onMouseLeave={() => setHoveredSegmentKey((current) => (
                          current === segmentKey ? null : current
                        ))}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          if (!onSegmentClick) return;
                          const numericValue = Array.isArray(value) ? value[1] - value[0] : Number(value) || 0;
                          if (!payload || numericValue <= 0) return;
                          onSegmentClick(series.key, payload);
                        }}
                      >
                        <rect
                          x={x}
                          y={y}
                          width={width}
                          height={height}
                          fill={isHovered ? series.hoverColor : fill}
                          tabIndex={-1}
                          focusable="false"
                        />
                        {isHovered && innerWidth > 0 && innerHeight > 0 && (
                          <rect
                            x={innerX}
                            y={innerY}
                            width={innerWidth}
                            height={innerHeight}
                            fill="none"
                            stroke="rgba(15, 23, 42, 0.28)"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        )}
                      </g>
                    );
                  }}
                />
              ))}
            </BarChart>
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
  );
}
