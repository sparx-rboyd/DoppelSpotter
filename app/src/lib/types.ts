import type { Timestamp } from 'firebase-admin/firestore';

// ─── Brand Profile ─────────────────────────────────────────────────────────

export interface BrandProfile {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  officialDomains: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type BrandProfileCreateInput = Omit<BrandProfile, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;

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

export interface Finding {
  id: string;
  scanId: string;
  brandId: string;
  userId: string;
  source: FindingSource;
  actorId: string;
  severity: Severity;
  title: string;
  description: string;
  llmAnalysis: string;
  url?: string;
  rawData: Record<string, unknown>;
  createdAt: Timestamp;
}

// ─── Scans ─────────────────────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Scan {
  id: string;
  brandId: string;
  userId: string;
  status: ScanStatus;
  actorIds: string[];
  findingCount: number;
  errorMessage?: string;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

// ─── LLM Analysis ──────────────────────────────────────────────────────────

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
