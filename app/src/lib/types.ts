import type { Timestamp } from '@google-cloud/firestore';

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Timestamp;
}

// ─── Brand Profile ─────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  officialDomains: string[];
  /** Internal pointer to the currently active scan for this brand, if any. */
  activeScanId?: string;
  /** Terms AI analysis should flag if found associated with the brand in search results. */
  watchWords?: string[];
  /** Terms the brand owner is comfortable being associated with; AI analysis treats results containing these with reduced caution. */
  safeWords?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type BrandProfileCreateInput = Omit<BrandProfile, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

export interface BrandSummary {
  id: string;
  name: string;
  keywordCount: number;
  officialDomainCount: number;
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

export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  /** Total items in the dataset — set once the dataset has been fetched */
  itemCount?: number;
  /** Number of items that have completed AI analysis so far */
  analysedCount?: number;
  /**
   * 0 = initial scan run; 1 = AI-requested deep follow-up.
   * Deep searches are never spawned from depth > 0 (loop guard).
   */
  searchDepth?: number;
  /** The literal query string used for this run — set on deep follow-up runs */
  searchQuery?: string;
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
