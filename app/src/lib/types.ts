import type { Timestamp } from '@google-cloud/firestore';

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  /** Bumped whenever credentials change so older JWT sessions can be rejected. */
  sessionVersion?: number;
  /** Timestamp when the password was last changed. */
  passwordChangedAt?: Timestamp;
  /** Optional per-user dashboard state persisted across devices. */
  dashboardPreferences?: DashboardPreferences;
  createdAt: Timestamp;
}

export interface DashboardPreferences {
  /** The user's preferred dashboard brand selection. */
  selectedBrandId?: string;
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

export interface BrandScanSources {
  google: boolean;
  reddit: boolean;
  tiktok: boolean;
  youtube: boolean;
  facebook: boolean;
  instagram: boolean;
}

// ─── Brand Profile ─────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  officialDomains: string[];
  /** User-configured scan depth (1-10); Google-backed scans currently map this to search result pages. */
  searchResultPages?: number;
  /** Whether completed scans should send a summary email to the brand owner's account email. */
  sendScanSummaryEmails?: boolean;
  /** Whether AI analysis may trigger follow-up deep-search runs for this brand. */
  allowAiDeepSearches?: boolean;
  /** User-configured deep search breadth (1-10) limiting AI-requested follow-up searches. */
  maxAiDeepSearches?: number;
  /** Which scan surfaces are enabled for this brand; current implementations are Google-backed. */
  scanSources?: BrandScanSources;
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
  searchResultPages?: number;
  sendScanSummaryEmails?: boolean;
  allowAiDeepSearches?: boolean;
  maxAiDeepSearches?: number;
  scanSources?: BrandScanSources;
  watchWords?: string[];
  safeWords?: string[];
  scanSchedule?: BrandScanScheduleInput;
}

export interface BrandProfileUpdateInput {
  name?: string;
  keywords?: string[];
  officialDomains?: string[];
  searchResultPages?: number;
  sendScanSummaryEmails?: boolean;
  allowAiDeepSearches?: boolean;
  maxAiDeepSearches?: number;
  scanSources?: BrandScanSources;
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

export interface DashboardBootstrapData {
  brands: BrandSummary[];
  selectedBrandId: string | null;
}

export interface DashboardPreferenceUpdateInput {
  selectedBrandId: string | null;
}

// ─── Findings ──────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';
export type FindingCategory = Severity | 'non-hit';
export type UserPreferenceSignal = 'positive' | 'negative';
export type UserPreferenceSignalReason =
  | 'ignored'
  | 'reclassified_to_non_hit'
  | 'reclassified_non_hit_to_high';

export type FindingSource =
  | 'google'
  | 'reddit'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'unknown';

export interface FindingSummary {
  id: string;
  scanId: string;
  brandId: string;
  source: FindingSource;
  severity: Severity;
  title: string;
  /** Short LLM-assigned theme label (preferably 1 word, max 3 words). */
  theme?: string;
  llmAnalysis: string;
  url?: string;
  /** Set to true for AI-classified false positives (not real threats). */
  isFalsePositive?: boolean;
  /** Set to true when the user manually dismisses this finding. */
  isIgnored?: boolean;
  /** Set to true when the user marks this finding as addressed. */
  isAddressed?: boolean;
  /** Set to true when the user bookmarks the finding for follow-up. */
  isBookmarked?: boolean;
  /** Timestamp when the finding was marked as addressed by the user. */
  addressedAt?: Timestamp;
  /** Timestamp when the finding was bookmarked by the user. */
  bookmarkedAt?: Timestamp;
  /** Optional user note attached to this finding. */
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
  /** Explicit user-review preference signal captured from manual ignore/reclassification actions only. */
  userPreferenceSignal?: UserPreferenceSignal;
  /** Why the explicit user-review preference signal was recorded. */
  userPreferenceSignalReason?: UserPreferenceSignalReason;
  /** When the explicit user-review preference signal was last recorded. */
  userPreferenceSignalAt?: Timestamp;
  /** Previous user-visible category before the last manual reclassification, when applicable. */
  userReclassifiedFrom?: FindingCategory;
  /** New user-visible category after the last manual reclassification, when applicable. */
  userReclassifiedTo?: FindingCategory;
  /** The exact system + user prompt transcript sent for AI analysis. */
  llmAnalysisPrompt?: string;
  /** The raw JSON string returned by AI analysis before parsing. */
  rawLlmResponse?: string;
}

// ─── Scans ─────────────────────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'running' | 'summarising' | 'completed' | 'failed' | 'cancelled';
export type ScanSummaryEmailStatus = 'sending' | 'sent' | 'failed' | 'skipped';
export type UserPreferenceHintsStatus = 'pending' | 'ready' | 'failed';
export type GoogleScannerId =
  | 'google-web'
  | 'google-reddit'
  | 'google-tiktok'
  | 'google-youtube'
  | 'google-facebook'
  | 'google-instagram';

export type ActorRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_preference_hints'
  | 'fetching_dataset'
  | 'analysing'
  | 'succeeded'
  | 'failed';

export interface UserPreferenceHints {
  version: 1;
  generatedFromSignalCount: number;
  globalLines: string[];
  sourceLines?: Partial<Record<FindingSource, string[]>>;
}

export interface ActorRunInfo {
  /** Stable logical scanner identifier, independent from the underlying Apify actor ID. */
  scannerId: GoogleScannerId;
  actorId: string;
  source: FindingSource;
  /** Apify run status for this individual actor */
  status: ActorRunStatus;
  /** Default dataset identifier captured when a succeeded webhook arrives before preference hints are ready. */
  datasetId?: string;
  /** Total deduped Google result candidates queued for classification in this run. */
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
  /** The literal executable query string used for this run. */
  searchQuery?: string;
  /** The user-visible query text with internal site operators removed. */
  displayQuery?: string;
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
  /** The actor IDs started for this scan (currently always Google Search only). */
  actorIds: string[];
  /** Flat array of Apify run IDs — used for Firestore array-contains queries in the webhook handler */
  actorRunIds?: string[];
  /** Per-actor run details, keyed by Apify run ID */
  actorRuns?: Record<string, ActorRunInfo>;
  /** How many actor runs have completed (succeeded or failed) — used to detect scan completion */
  completedRunCount?: number;
  /** Total persisted non-false-positive findings, including ignored and addressed items. */
  findingCount: number;
  /** Denormalized visible per-severity counts — written by the webhook and updated on finding state changes */
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  nonHitCount?: number;
  ignoredCount?: number;
  addressedCount?: number;
  /** Number of duplicate URLs skipped because they already appeared in previous scans. */
  skippedCount?: number;
  /** Whether the scan-level soft user-preference hints are still being prepared. */
  userPreferenceHintsStatus?: UserPreferenceHintsStatus;
  /** Tiny scan-level soft guidance derived from prior explicit user-review signals. */
  userPreferenceHints?: UserPreferenceHints;
  /** Most recent preference-hint preparation error message, if generation failed. */
  userPreferenceHintsError?: string;
  /** When scan-level preference-hint preparation began. */
  userPreferenceHintsStartedAt?: Timestamp;
  /** When scan-level preference-hint preparation finished. */
  userPreferenceHintsCompletedAt?: Timestamp;
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
  addressedCount: number;
  skippedCount: number;
  aiSummary?: string;
}

export interface DashboardMetricTotals {
  high: number;
  medium: number;
  low: number;
  nonHit: number;
}

export type DashboardBreakdownCategory = keyof DashboardMetricTotals;

export interface DashboardBreakdownRow extends DashboardMetricTotals {
  label: string;
  filterValue?: string;
  total: number;
  drilldownScanIds?: Partial<Record<DashboardBreakdownCategory, string>>;
}

export interface DashboardActiveScanSummary {
  id: string;
  status: ScanStatus;
  startedAt: Timestamp;
}

export interface DashboardMetricsData {
  brandId: string;
  selectedScanId: string | null;
  hasTerminalScans: boolean;
  activeScan: DashboardActiveScanSummary | null;
  scanOptions: ScanSummary[];
  totals: DashboardMetricTotals;
  sourceBreakdown: DashboardBreakdownRow[];
  themeBreakdown: DashboardBreakdownRow[];
}

// ─── AI Analysis ───────────────────────────────────────────────────────────

export interface AnalysisResult {
  severity: Severity;
  title: string;
  theme?: string;
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
