import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import {
  DEFAULT_ALLOW_AI_DEEP_SEARCHES,
  isValidAllowAiDeepSearches,
  DEFAULT_MAX_AI_DEEP_SEARCHES,
  isValidMaxAiDeepSearches,
} from '@/lib/brands';
import type { BrandProfile, BrandProfileCreateInput, BrandSummary } from '@/lib/types';

// GET /api/brands — list all brands for the authenticated user
export async function GET(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;
  void request;

  const snapshot = await db
    .collection('brands')
    .where('userId', '==', uid)
    .select('name', 'keywords', 'officialDomains', 'createdAt')
    .orderBy('createdAt', 'desc')
    .get();

  const brands: BrandSummary[] = snapshot.docs.map((doc) => {
    const data = doc.data() as Pick<BrandProfile, 'name' | 'keywords' | 'officialDomains' | 'createdAt'>;
    return {
      id: doc.id,
      name: data.name,
      keywordCount: data.keywords.length,
      officialDomainCount: data.officialDomains.length,
      createdAt: data.createdAt,
    };
  });

  return NextResponse.json({ data: brands });
}

// POST /api/brands — create a new brand profile
export async function POST(request: NextRequest) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  let body: BrandProfileCreateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const {
    name,
    keywords = [],
    officialDomains = [],
    watchWords = [],
    safeWords = [],
    allowAiDeepSearches = DEFAULT_ALLOW_AI_DEEP_SEARCHES,
    maxAiDeepSearches = DEFAULT_MAX_AI_DEEP_SEARCHES,
  } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse('Brand name is required');
  }

  if (!isValidAllowAiDeepSearches(allowAiDeepSearches)) {
    return errorResponse('allowAiDeepSearches must be a boolean');
  }

  if (!isValidMaxAiDeepSearches(maxAiDeepSearches)) {
    return errorResponse('maxAiDeepSearches must be a whole number from 1 to 10');
  }

  const docRef = db.collection('brands').doc();
  const now = FieldValue.serverTimestamp();
  const nowDate = new Date();

  const brandData = {
    userId: uid,
    name: name.trim(),
    keywords: keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    officialDomains: officialDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean),
    allowAiDeepSearches,
    maxAiDeepSearches,
    watchWords: (watchWords as string[]).map((w) => String(w).trim().toLowerCase()).filter(Boolean),
    safeWords: (safeWords as string[]).map((w) => String(w).trim().toLowerCase()).filter(Boolean),
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(brandData);

  // Return JS Dates in the response — FieldValue.serverTimestamp() is a write sentinel
  // that only resolves inside Firestore and cannot be serialised directly.
  return NextResponse.json({
    data: { id: docRef.id, ...brandData, createdAt: nowDate, updatedAt: nowDate },
  }, { status: 201 });
}
