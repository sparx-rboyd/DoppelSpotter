import type { Timestamp } from '@google-cloud/firestore';

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Timestamp;
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

export type ScanScheduleFrequency = 'daily' | 'weekly' | 'fortnightly' | 'monthly';

export interface BrandScanSchedule {
  enabled: boolean;
  frequency: ScanScheduleFrequency;
  /** IANA timezone identifier, e.g. Europe/London */
  timeZone: string;
  /** The original user-selected local date/time, stored as a UTC instant. */
  startAt: Timestamp;
  /** The next due occurrence, precomputed so scheduled dispatch can query efficiently. */
  nextRunAt: Timestamp;
  /** When a scheduled scan last successfully reserved a new scan. */
  lastTriggeredAt?: Timestamp;
  /** The most recent scan started by the scheduler for this brand. */
  lastScheduledScanId?: string;
}

export interface BrandScanScheduleInput {
  enabled: boolean;
  frequency: ScanScheduleFrequency;
  timeZone: string;
  /** YYYY-MM-DD in the selected timezone */
  startDate: string;
  /** HH:mm in the selected timezone */
  startTime: string;
}

// ─── Brand Profile ─────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  officialDomains: string[];
  /** Whether completed scans should send a summary email to the brand owner's account email. */
  sendScanSummaryEmails?: boolean;
  /** Whether AI analysis may trigger Google deep-search follow-up runs for this brand. */
  allowAiDeepSearches?: boolean;
  /** Maximum number of AI-requested Google follow-up searches allowed for this brand. */
  maxAiDeepSearches?: number;
  /** Internal pointer to the currently active scan for this brand, if any. */
  activeScanId?: string;
  /** Terms AI analysis should flag if found associated with the brand in search results. */
  watchWords?: string[];
  /** Terms the brand owner is comfortable being associated with; AI analysis treats results containing these with reduced caution. */
  safeWords?: string[];
  /** Optional recurring schedule for automatic scans. */
  scanSchedule?: BrandScanSchedule;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface BrandProfileCreateInput {
  name: string;
  keywords?: string[];
  officialDomains?: string[];
  sendScanSummaryEmails?: boolean;
  allowAiDeepSearches?: boolean;
  maxAiDeepSearches?: number;
  watchWords?: string[];
  safeWords?: string[];
  scanSchedule?: BrandScanScheduleInput;
}

export interface BrandProfileUpdateInput {
  name?: string;
  keywords?: string[];
  officialDomains?: string[];
  sendScanSummaryEmails?: boolean;
  allowAiDeepSearches?: boolean;
  maxAiDeepSearches?: number;
  watchWords?: string[];
  safeWords?: string[];
  scanSchedule?: BrandScanScheduleInput;
}

export interface BrandSummary {
  id: string;
  name: string;
  scanCount: number;
  findingCount: number;
  nonHitCount: number;
  isScanInProgress: boolean;
  lastScanStartedAt?: Timestamp;
  scanSchedule?: Pick<BrandScanSchedule, 'enabled' | 'timeZone' | 'nextRunAt'>;
  createdAt: Timestamp;
}

// ─── Findings ──────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';

export type FindingSource =
  | 'domain'
  | 'instagram'
  | 'twitter'
  | 'facebook'
  | 'tiktok'
  | 'google'
  | 'google-play'
  | 'app-store'
  | 'trademark'
  | 'unknown';

export interface FindingSummary {
  id: string;
  scanId: string;
  brandId: string;
  source: FindingSource;
  severity: Severity;
  title: string;
  llmAnalysis: string;
  url?: string;
  /** Set to true for AI-classified false positives (not real threats). */
  isFalsePositive?: boolean;
  /** Set to true when the user manually dismisses this finding. */
  isIgnored?: boolean;
  /** Set to true when the user bookmarks the finding for follow-up. */
  isBookmarked?: boolean;
  /** Timestamp when the finding was bookmarked by the user. */
  bookmarkedAt?: Timestamp;
  /** Optional reminder note attached to a bookmarked finding. */
  bookmarkNote?: string;
  createdAt: Timestamp;
}

export interface Finding extends FindingSummary {
  userId: string;
  actorId: string;
  description: string;
  rawData: Record<string, unknown>;
  /** Timestamp when the finding was ignored by the user. */
  ignoredAt?: Timestamp;
  /** The raw JSON string returned by AI analysis before parsing. */
  rawLlmResponse?: string;
}

// ─── Scans ─────────────────────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'running' | 'summarising' | 'completed' | 'failed' | 'cancelled';
export type ScanSummaryEmailStatus = 'sending' | 'sent' | 'failed' | 'skipped';

export type ActorRunStatus =
  | 'pending'
  | 'running'
  | 'fetching_dataset'
  | 'analysing'
  | 'succeeded'
  | 'failed';

export interface ActorRunInfo {
  actorId: string;
  source: FindingSource;
  /** Apify run status for this individual actor */
  status: ActorRunStatus;
  /** Total analysable items for this run (dataset items for per-item actors, deduped result candidates for Google). */
  itemCount?: number;
  /** Number of items that have completed AI analysis so far. */
  analysedCount?: number;
  /** Number of URLs skipped because they already appeared in previous scans for this brand. */
  skippedDuplicateCount?: number;
  /**
   * 0 = initial scan run; 1 = AI-requested deep follow-up.
   * Deep searches are never spawned from depth > 0 (loop guard).
   */
  searchDepth?: number;
  /** The literal query string used for this run — set on deep follow-up runs */
  searchQuery?: string;
  /** Set once a depth-0 Google run has reserved its deep-search suggestions. */
  deepSearchSuggestionsProcessed?: boolean;
  /** The follow-up queries reserved for this run, if any. */
  suggestedSearches?: string[];
}

export interface Scan {
  id: string;
  brandId: string;
  userId: string;
  status: ScanStatus;
  /** The actor IDs requested for this scan */
  actorIds: string[];
  /** Flat array of Apify run IDs — used for Firestore array-contains queries in the webhook handler */
  actorRunIds?: string[];
  /** Per-actor run details, keyed by Apify run ID */
  actorRuns?: Record<string, ActorRunInfo>;
  /** How many actor runs have completed (succeeded or failed) — used to detect scan completion */
  completedRunCount?: number;
  /** Total non-false-positive findings (high + medium + low + ignored) */
  findingCount: number;
  /** Denormalized per-severity counts — written by the webhook and updated on ignore/un-ignore */
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  nonHitCount?: number;
  ignoredCount?: number;
  /** Number of duplicate URLs skipped because they already appeared in previous scans. */
  skippedCount?: number;
  /** Succinct AI-generated overview of the scan's high/medium/low findings. */
  aiSummary?: string;
  /** Delivery status for the optional post-scan summary email. */
  scanSummaryEmailStatus?: ScanSummaryEmailStatus;
  /** When scan summary email delivery was last attempted or explicitly skipped. */
  scanSummaryEmailAttemptedAt?: Timestamp;
  /** When the scan summary email was successfully sent. */
  scanSummaryEmailSentAt?: Timestamp;
  /** Provider message identifier returned by MailerSend. */
  scanSummaryEmailMessageId?: string;
  /** Most recent email delivery error message, if sending failed. */
  scanSummaryEmailError?: string;
  /** When the final scan-level summary step began. */
  summaryStartedAt?: Timestamp;
  errorMessage?: string;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

// ─── Scan Summary ──────────────────────────────────────────────────────────

/** Lightweight scan shape returned by the scans list endpoint, with pre-computed severity counts. */
export interface ScanSummary {
  id: string;
  status: ScanStatus;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  nonHitCount: number;
  ignoredCount: number;
  skippedCount: number;
  aiSummary?: string;
}

// ─── AI Analysis ───────────────────────────────────────────────────────────

export interface AnalysisResult {
  severity: Severity;
  title: string;
  llmAnalysis: string;
  isFalsePositive: boolean;
}

// ─── API response shapes ────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
}

export interface ApiSuccess<T> {
  data: T;
}
