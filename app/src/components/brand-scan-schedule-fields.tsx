'use client';

import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { SelectDropdown, type SelectDropdownOption } from '@/components/ui/select-dropdown';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  formatScanScheduleFrequency,
  getMinimumScheduleStart,
  getSupportedTimeZones,
  parseScheduleStart,
} from '@/lib/scan-schedules';
import type { BrandScanScheduleInput } from '@/lib/types';

type BrandScanScheduleFieldsProps = {
  value: BrandScanScheduleInput;
  onChange: (nextValue: BrandScanScheduleInput) => void;
};

type FloatingPanelProps = {
  anchorRef: MutableRefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  matchTriggerWidth?: boolean;
  className?: string;
  children: ReactNode;
};

type DateFieldProps = {
  id: string;
  label: string;
  tooltip: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  minDate?: string;
  labelTone?: 'default' | 'subtle';
};

type TimeFieldProps = {
  id: string;
  label: string;
  tooltip: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  minTime?: string;
  labelTone?: 'default' | 'subtle';
};

const FLOATING_PANEL_GAP_PX = 8;
const FLOATING_PANEL_VIEWPORT_MARGIN_PX = 12;
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const FREQUENCY_OPTIONS: SelectDropdownOption[] = (['daily', 'weekly', 'fortnightly', 'monthly'] as const).map((frequency) => ({
  value: frequency,
  label: formatScanScheduleFrequency(frequency),
}));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));

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
    case 'monthly': {
      const fallbackNote = start.day >= 29 ? ' Shorter months use the last day.' : '';
      return `Runs on the ${start.day}${ordinalSuffix(start.day)} of each month at ${time} (${zone}).${fallbackNote}`;
    }
  }
}

function buildFieldLabel(
  id: string,
  label: string,
  tooltip: string,
  tone: 'default' | 'subtle' = 'default',
) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium',
        tone === 'subtle' ? 'text-xs text-gray-500' : 'text-sm text-gray-700',
      )}
    >
      {label}
      <InfoTooltip content={tooltip} />
    </label>
  );
}

function buildTriggerButtonClassName(disabled?: boolean) {
  return cn(
    'brand-form-input flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm text-gray-900 transition',
    'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
    'border-gray-300 bg-white',
    disabled && 'cursor-not-allowed bg-gray-50 text-gray-400',
  );
}

function FloatingPanel({
  anchorRef,
  isOpen,
  onClose,
  matchTriggerWidth = true,
  className,
  children,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 0 });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const panelRect = panelRef.current?.getBoundingClientRect();
    const naturalPanelWidth = matchTriggerWidth
      ? rect.width
      : panelRef.current?.scrollWidth ?? panelRect?.width ?? rect.width;
    const naturalPanelHeight = panelRef.current?.scrollHeight ?? panelRect?.height ?? 0;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const preferredTop = rect.bottom + FLOATING_PANEL_GAP_PX;
    const maxLeft = Math.max(
      FLOATING_PANEL_VIEWPORT_MARGIN_PX,
      viewportWidth - naturalPanelWidth - FLOATING_PANEL_VIEWPORT_MARGIN_PX,
    );
    const left = Math.max(
      FLOATING_PANEL_VIEWPORT_MARGIN_PX,
      Math.min(rect.left, maxLeft),
    );

    const spaceBelow = viewportHeight - preferredTop - FLOATING_PANEL_VIEWPORT_MARGIN_PX;
    const spaceAbove = rect.top - FLOATING_PANEL_GAP_PX - FLOATING_PANEL_VIEWPORT_MARGIN_PX;
    const shouldRenderAbove =
      naturalPanelHeight > 0 &&
      spaceBelow < naturalPanelHeight &&
      spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      0,
      shouldRenderAbove ? spaceAbove : spaceBelow,
    );
    const renderedPanelHeight = naturalPanelHeight > 0
      ? Math.min(naturalPanelHeight, maxHeight)
      : maxHeight;

    const top = shouldRenderAbove
      ? Math.max(
          FLOATING_PANEL_VIEWPORT_MARGIN_PX,
          rect.top - FLOATING_PANEL_GAP_PX - renderedPanelHeight,
        )
      : Math.max(
          FLOATING_PANEL_VIEWPORT_MARGIN_PX,
          Math.min(
            preferredTop,
            viewportHeight - FLOATING_PANEL_VIEWPORT_MARGIN_PX - renderedPanelHeight,
          ),
        );

    setPosition((current) => {
      const nextPosition = {
        top,
        left,
        width: rect.width,
        maxHeight,
      };

      if (
        current.top === nextPosition.top &&
        current.left === nextPosition.left &&
        current.width === nextPosition.width &&
        current.maxHeight === nextPosition.maxHeight
      ) {
        return current;
      }

      return nextPosition;
    });
  }, [anchorRef, matchTriggerWidth]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();
    const frameId = window.requestAnimationFrame(updatePosition);

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    }

    function handleViewportChange() {
      updatePosition();
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [anchorRef, isOpen, updatePosition]);

  if (!isMounted || !isOpen) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        'fixed z-[120] overflow-y-auto rounded-xl border border-gray-200 bg-white p-2',
        className,
      )}
      style={{
        top: position.top,
        left: position.left,
        width: matchTriggerWidth ? position.width : undefined,
        maxHeight: position.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function DateField({
  id,
  label,
  tooltip,
  value,
  onChange,
  disabled,
  minDate,
  labelTone = 'default',
}: DateFieldProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const selectedDate = useMemo(() => DateTime.fromISO(value), [value]);
  const minimumDate = useMemo(
    () => (minDate ? DateTime.fromISO(minDate).startOf('day') : null),
    [minDate],
  );
  const [visibleMonth, setVisibleMonth] = useState(
    (selectedDate.isValid ? selectedDate : DateTime.now()).startOf('month'),
  );

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (isOpen) {
      const nextVisibleMonth = (selectedDate.isValid ? selectedDate : DateTime.now()).startOf('month');
      setVisibleMonth((current) => (
        current.hasSame(nextVisibleMonth, 'month') ? current : nextVisibleMonth
      ));
    }
  }, [isOpen, selectedDate]);

  const calendarStart = visibleMonth.startOf('month').startOf('week');
  const calendarDays = Array.from({ length: 42 }, (_, index) => calendarStart.plus({ days: index }));

  return (
    <div className="flex flex-col gap-1">
      {buildFieldLabel(id, label, tooltip, labelTone)}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => {
          if (!disabled) setIsOpen((current) => !current);
        }}
        className={buildTriggerButtonClassName(disabled)}
      >
        <CalendarDays className="h-4 w-4 text-gray-400" />
        <span className="min-w-0 flex-1 text-left">
          {selectedDate.isValid ? selectedDate.toFormat('dd/LL/yyyy') : 'Select date'}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-gray-400 transition', isOpen && 'rotate-180')} />
      </button>

      <FloatingPanel
        anchorRef={triggerRef as MutableRefObject<HTMLElement | null>}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        matchTriggerWidth={false}
        className="w-[304px]"
      >
        <div className="flex items-center justify-between px-1 pb-2">
          <button
            type="button"
            onClick={() => setVisibleMonth((current) => current.minus({ months: 1 }))}
            className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium text-gray-900">
            {visibleMonth.toFormat('LLLL yyyy')}
          </span>
          <button
            type="button"
            onClick={() => setVisibleMonth((current) => current.plus({ months: 1 }))}
            className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 px-1 pb-2">
          {WEEKDAY_LABELS.map((weekday, index) => (
            <span
              key={`${weekday}-${index}`}
              className="flex h-8 items-center justify-center text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              {weekday}
            </span>
          ))}
          {calendarDays.map((day) => {
            const isCurrentMonth = day.month === visibleMonth.month;
            const isSelected = selectedDate.isValid && day.hasSame(selectedDate, 'day');
            const isBeforeMinimumDate = minimumDate ? day.startOf('day') < minimumDate : false;

            return (
              <button
                key={day.toISODate()}
                type="button"
                disabled={isBeforeMinimumDate}
                onClick={() => {
                  onChange(day.toFormat('yyyy-LL-dd'));
                  setIsOpen(false);
                }}
                className={cn(
                  'flex h-9 items-center justify-center rounded-lg text-sm transition',
                  isBeforeMinimumDate && 'cursor-not-allowed text-gray-200 hover:bg-transparent',
                  isSelected
                    ? 'bg-brand-600 font-medium text-white'
                    : isBeforeMinimumDate
                      ? ''
                      : isCurrentMonth
                      ? 'text-gray-700 hover:bg-gray-100'
                      : 'text-gray-300 hover:bg-gray-50',
                )}
              >
                {day.day}
              </button>
            );
          })}
        </div>
      </FloatingPanel>
    </div>
  );
}

function TimeField({
  id,
  label,
  tooltip,
  value,
  onChange,
  disabled,
  minTime,
  labelTone = 'default',
}: TimeFieldProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedHour = '00', selectedMinute = '00'] = value.split(':');
  const minimumMinutes = useMemo(() => {
    if (!minTime) return null;

    const [hour = '00', minute = '00'] = minTime.split(':');
    return (Number(hour) * 60) + Number(minute);
  }, [minTime]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  function getMinutes(hour: string, minute: string): number {
    return (Number(hour) * 60) + Number(minute);
  }

  function updateTime(nextHour: string, nextMinute: string, closeAfterUpdate = false) {
    onChange(`${nextHour}:${nextMinute}`);
    if (closeAfterUpdate) {
      setIsOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {buildFieldLabel(id, label, tooltip, labelTone)}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => {
          if (!disabled) setIsOpen((current) => !current);
        }}
        className={buildTriggerButtonClassName(disabled)}
      >
        <Clock3 className="h-4 w-4 text-gray-400" />
        <span className="min-w-0 flex-1 text-left">{value}</span>
        <ChevronDown className={cn('h-4 w-4 text-gray-400 transition', isOpen && 'rotate-180')} />
      </button>

      <FloatingPanel
        anchorRef={triggerRef as MutableRefObject<HTMLElement | null>}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        matchTriggerWidth={false}
        className="w-[304px]"
      >
        <div className="mb-2 px-1">
          <p className="text-sm font-medium text-gray-900">{selectedHour}:{selectedMinute}</p>
          <p className="text-xs text-gray-500">
            {minTime ? `Earliest available time today is ${minTime}.` : 'Choose an hour and minute.'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <p className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Hour</p>
            <div className="max-h-56 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-1">
              {HOUR_OPTIONS.map((hour) => {
                const isSelected = hour === selectedHour;
                const isDisabled = minimumMinutes !== null && getMinutes(hour, '59') < minimumMinutes;
                return (
                  <button
                    key={hour}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      const nextMinute = minimumMinutes !== null && getMinutes(hour, selectedMinute) < minimumMinutes
                        ? String(minimumMinutes % 60).padStart(2, '0')
                        : selectedMinute;
                      updateTime(hour, nextMinute);
                    }}
                    className={cn(
                      'flex w-full items-center justify-center rounded-md px-2 py-2 text-sm transition',
                      isDisabled && 'cursor-not-allowed text-gray-300 hover:bg-transparent',
                      isSelected
                        ? 'bg-brand-600 font-medium text-white'
                        : isDisabled
                          ? ''
                          : 'text-gray-700 hover:bg-white',
                    )}
                  >
                    {hour}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-w-0">
            <p className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Minute</p>
            <div className="max-h-56 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-1">
              {MINUTE_OPTIONS.map((minute) => {
                const isSelected = minute === selectedMinute;
                const isDisabled = minimumMinutes !== null && getMinutes(selectedHour, minute) < minimumMinutes;
                return (
                  <button
                    key={minute}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => updateTime(selectedHour, minute, true)}
                    className={cn(
                      'flex w-full items-center justify-center rounded-md px-2 py-2 text-sm transition',
                      isDisabled && 'cursor-not-allowed text-gray-300 hover:bg-transparent',
                      isSelected
                        ? 'bg-brand-600 font-medium text-white'
                        : isDisabled
                          ? ''
                          : 'text-gray-700 hover:bg-white',
                    )}
                  >
                    {minute}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </FloatingPanel>
    </div>
  );
}

export function BrandScanScheduleFields({
  value,
  onChange,
}: BrandScanScheduleFieldsProps) {
  const timeZones = useMemo(
    () => getSupportedTimeZones().map((timeZone) => ({ value: timeZone, label: timeZone })),
    [],
  );
  const minimumStart = getMinimumScheduleStart(value.timeZone);
  const minimumDate = minimumStart.toFormat('yyyy-LL-dd');
  const minimumTime = value.startDate === minimumDate ? minimumStart.toFormat('HH:mm') : undefined;
  const summary = buildScheduleSummary(value);

  function updateValue(patch: Partial<BrandScanScheduleInput>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
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
          className={`inline-flex items-center gap-2 rounded-md text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            value.enabled ? 'text-brand-700' : 'text-gray-600'
          }`}
        >
          <span>{value.enabled ? 'On' : 'Off'}</span>
          <span
            className={`relative inline-flex h-6 w-11 rounded-full transition ${
              value.enabled ? 'bg-brand-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                value.enabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </span>
        </button>
      </div>

      {value.enabled && (
        <div className="mt-3 -mx-6 border-t border-gray-100 bg-gray-50 px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <SelectDropdown
              id="schedule-frequency"
              label="Frequency"
              tooltip="The selected start date anchors weekly, fortnightly, and monthly repeats."
              value={value.frequency}
              options={FREQUENCY_OPTIONS}
              onChange={(nextValue) => updateValue({ frequency: nextValue as BrandScanScheduleInput['frequency'] })}
              labelTone="subtle"
            />

            <SelectDropdown
              id="schedule-timezone"
              label="Timezone"
              tooltip="Scheduled scans stay pinned to this local timezone, including through daylight saving changes."
              value={value.timeZone}
              options={timeZones}
              onChange={(nextValue) => updateValue({ timeZone: nextValue })}
              searchable
              searchPlaceholder="Search timezones"
              labelTone="subtle"
            />

            <DateField
              id="schedule-start-date"
              label="Start date"
              tooltip="The first local date used to anchor the repeating schedule."
              value={value.startDate}
              onChange={(nextValue) => updateValue({ startDate: nextValue })}
              minDate={minimumDate}
              labelTone="subtle"
            />

            <TimeField
              id="schedule-start-time"
              label="Time"
              tooltip="Scheduled scans will run within 10 minutes of the scheduled start time."
              value={value.startTime}
              onChange={(nextValue) => updateValue({ startTime: nextValue })}
              minTime={minimumTime}
              labelTone="subtle"
            />
          </div>
        </div>
      )}
    </div>
  );
}
