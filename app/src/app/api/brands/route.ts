import { NextResponse, type NextRequest } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from 'firebase-admin/firestore';
import type { BrandProfile, BrandProfileCreateInput } from '@/lib/types';

// GET /api/brands — list all brands for the authenticated user
export async function GET(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  const snapshot = await adminDb
    .collection('brands')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .get();

  const brands: BrandProfile[] = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<BrandProfile, 'id'>),
  }));

  return NextResponse.json({ data: brands });
}

// POST /api/brands — create a new brand profile
export async function POST(request: NextRequest) {
  const { uid, error } = await requireAuth(request);
  if (error) return error;

  let body: BrandProfileCreateInput;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { name, keywords = [], officialDomains = [] } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse('Brand name is required');
  }

  const docRef = adminDb.collection('brands').doc();
  const now = FieldValue.serverTimestamp();

  const brandData = {
    userId: uid,
    name: name.trim(),
    keywords: keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    officialDomains: officialDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean),
    createdAt: now,
    updatedAt: now,
  };

  await docRef.set(brandData);

  return NextResponse.json({ data: { id: docRef.id, ...brandData } }, { status: 201 });
}
