import { DateTime } from 'luxon';
import type {
  BrandScanSchedule,
  BrandScanScheduleInput,
  ScanScheduleFrequency,
} from './types';

export const SCAN_SCHEDULE_FREQUENCIES = [
  'daily',
  'weekly',
  'fortnightly',
  'monthly',
] as const;

export const DEFAULT_SCAN_SCHEDULE_FREQUENCY: ScanScheduleFrequency = 'weekly';
export const DEFAULT_SCAN_SCHEDULE_START_TIME = '09:00';

type AnyTimestampLike =
  | Date
  | { toDate(): Date }
  | { _seconds: number; _nanoseconds: number }
  | { seconds: number; nanoseconds: number };

type ScheduleAnchorLike = Pick<BrandScanSchedule, 'frequency' | 'timeZone'> & {
  startAt: AnyTimestampLike;
};

export interface ResolvedBrandScanSchedule {
  enabled: boolean;
  frequency: ScanScheduleFrequency;
  timeZone: string;
  startAt: Date;
  nextRunAt: Date;
}

function toDate(value: AnyTimestampLike): Date {
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate();
  }
  if ('_seconds' in value) return new Date((value as { _seconds: number })._seconds * 1000);
  if ('seconds' in value) return new Date((value as { seconds: number }).seconds * 1000);
  return value as Date;
}

function toZonedDateTime(value: AnyTimestampLike, timeZone: string): DateTime {
  return DateTime.fromJSDate(toDate(value), { zone: timeZone });
}

function getIntervalSize(frequency: ScanScheduleFrequency): number {
  switch (frequency) {
    case 'daily':
    case 'weekly':
    case 'monthly':
      return 1;
    case 'fortnightly':
      return 2;
  }
}

function addInterval(dateTime: DateTime, frequency: ScanScheduleFrequency): DateTime {
  switch (frequency) {
    case 'daily':
      return dateTime.plus({ days: 1 });
    case 'weekly':
      return dateTime.plus({ weeks: 1 });
    case 'fortnightly':
      return dateTime.plus({ weeks: 2 });
    case 'monthly':
      return dateTime.plus({ months: 1 });
  }
}

function getElapsedIntervals(anchor: DateTime, reference: DateTime, frequency: ScanScheduleFrequency): number {
  switch (frequency) {
    case 'daily':
      return Math.max(0, Math.floor(reference.diff(anchor, 'days').days));
    case 'weekly':
      return Math.max(0, Math.floor(reference.diff(anchor, 'weeks').weeks));
    case 'fortnightly':
      return Math.max(0, Math.floor(reference.diff(anchor, 'weeks').weeks / getIntervalSize(frequency)));
    case 'monthly':
      return Math.max(0, Math.floor(reference.diff(anchor, 'months').months));
  }
}

function getCandidateAtIntervals(anchor: DateTime, frequency: ScanScheduleFrequency, intervals: number): DateTime {
  switch (frequency) {
    case 'daily':
      return anchor.plus({ days: intervals });
    case 'weekly':
      return anchor.plus({ weeks: intervals });
    case 'fortnightly':
      return anchor.plus({ weeks: intervals * getIntervalSize(frequency) });
    case 'monthly':
      return anchor.plus({ months: intervals });
  }
}

function isValidLocalScheduleStart(dateTime: DateTime, input: Pick<BrandScanScheduleInput, 'startDate' | 'startTime'>): boolean {
  return (
    dateTime.isValid &&
    dateTime.toFormat('yyyy-LL-dd') === input.startDate &&
    dateTime.toFormat('HH:mm') === input.startTime
  );
}

export function isValidScanScheduleFrequency(value: unknown): value is ScanScheduleFrequency {
  return SCAN_SCHEDULE_FREQUENCIES.includes(value as ScanScheduleFrequency);
}

export function isValidScanScheduleEnabled(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isValidTimeZone(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    DateTime.now().setZone(value).isValid
  );
}

export function isValidScheduleDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isValidScheduleTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

export function getBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function getSupportedTimeZones(): string[] {
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone');
  }

  return [getBrowserTimeZone(), 'UTC'];
}

export function getDefaultScheduleStartDate(now = new Date()): string {
  return DateTime.fromJSDate(now).toFormat('yyyy-LL-dd');
}

export function parseScheduleStart(input: Pick<BrandScanScheduleInput, 'startDate' | 'startTime' | 'timeZone'>): DateTime {
  return DateTime.fromISO(`${input.startDate}T${input.startTime}`, {
    zone: input.timeZone,
  });
}

export function computeInitialScheduledRun(anchor: ScheduleAnchorLike, now: AnyTimestampLike = new Date()): Date {
  const anchorDateTime = toZonedDateTime(anchor.startAt, anchor.timeZone);
  const reference = DateTime.fromJSDate(toDate(now), { zone: anchor.timeZone });
  if (anchorDateTime >= reference) {
    return anchorDateTime.toUTC().toJSDate();
  }

  return computeNextScheduledRun(anchor, now);
}

export function computeNextScheduledRun(anchor: ScheduleAnchorLike, after: AnyTimestampLike = new Date()): Date {
  const anchorDateTime = toZonedDateTime(anchor.startAt, anchor.timeZone);
  const reference = DateTime.fromJSDate(toDate(after), { zone: anchor.timeZone });

  if (!anchorDateTime.isValid || !reference.isValid) {
    throw new Error('Invalid schedule date');
  }

  let candidate = getCandidateAtIntervals(
    anchorDateTime,
    anchor.frequency,
    getElapsedIntervals(anchorDateTime, reference, anchor.frequency),
  );

  while (candidate <= reference) {
    candidate = addInterval(candidate, anchor.frequency);
  }

  return candidate.toUTC().toJSDate();
}

export function buildBrandScanSchedule(
  input: BrandScanScheduleInput,
  options?: { now?: Date },
): ResolvedBrandScanSchedule {
  if (!isValidScanScheduleEnabled(input.enabled)) {
    throw new Error('scanSchedule.enabled must be a boolean');
  }
  if (!isValidScanScheduleFrequency(input.frequency)) {
    throw new Error('scanSchedule.frequency must be daily, weekly, fortnightly or monthly');
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new Error('scanSchedule.timeZone must be a valid IANA timezone');
  }
  if (!isValidScheduleDate(input.startDate)) {
    throw new Error('scanSchedule.startDate must be in YYYY-MM-DD format');
  }
  if (!isValidScheduleTime(input.startTime)) {
    throw new Error('scanSchedule.startTime must be in HH:mm format');
  }

  const startAt = parseScheduleStart(input);
  if (!isValidLocalScheduleStart(startAt, input)) {
    throw new Error('scanSchedule start date/time is invalid for the selected timezone');
  }

  const startAtDate = startAt.toUTC().toJSDate();
  return {
    enabled: input.enabled,
    frequency: input.frequency,
    timeZone: input.timeZone,
    startAt: startAtDate,
    nextRunAt: computeInitialScheduledRun(
      {
        frequency: input.frequency,
        timeZone: input.timeZone,
        startAt: startAtDate,
      },
      options?.now ?? new Date(),
    ),
  };
}

export function isScheduledRunDue(schedule: Pick<BrandScanSchedule, 'enabled' | 'nextRunAt'>, now: AnyTimestampLike = new Date()): boolean {
  if (!schedule.enabled) return false;
  return toDate(schedule.nextRunAt).getTime() <= toDate(now).getTime();
}

export function getScheduleInputFromBrandSchedule(
  schedule: BrandScanSchedule | undefined,
  fallbackTimeZone = getBrowserTimeZone(),
): BrandScanScheduleInput {
  if (!schedule) {
    return {
      enabled: false,
      frequency: DEFAULT_SCAN_SCHEDULE_FREQUENCY,
      timeZone: fallbackTimeZone,
      startDate: getDefaultScheduleStartDate(),
      startTime: DEFAULT_SCAN_SCHEDULE_START_TIME,
    };
  }

  const startAt = toZonedDateTime(schedule.startAt, schedule.timeZone);
  return {
    enabled: schedule.enabled,
    frequency: schedule.frequency,
    timeZone: schedule.timeZone,
    startDate: startAt.toFormat('yyyy-LL-dd'),
    startTime: startAt.toFormat('HH:mm'),
  };
}

export function formatScheduledRunAt(value: AnyTimestampLike, timeZone: string): string {
  const dateTime = toZonedDateTime(value, timeZone);
  if (!dateTime.isValid) return '—';
  return `${dateTime.toFormat("cccc d LLLL yyyy 'at' HH:mm")} ${dateTime.offsetNameShort}`;
}

export function formatScheduledRunAtShort(value: AnyTimestampLike, timeZone: string): string {
  const dateTime = toZonedDateTime(value, timeZone);
  if (!dateTime.isValid) return '—';
  return dateTime.toFormat('d LLL yyyy, HH:mm');
}

export function formatScanScheduleFrequency(frequency: ScanScheduleFrequency): string {
  switch (frequency) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'fortnightly':
      return 'Fortnightly';
    case 'monthly':
      return 'Monthly';
  }
}
