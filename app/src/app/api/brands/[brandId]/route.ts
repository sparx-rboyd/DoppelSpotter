import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { requireAuth, errorResponse } from '@/lib/api-utils';
import { FieldValue } from '@google-cloud/firestore';
import type { BrandProfile } from '@/lib/types';

type Params = { params: Promise<{ brandId: string }> };

// GET /api/brands/[brandId]
export async function GET(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const doc = await db.collection('brands').doc(brandId).get();

  if (!doc.exists) return errorResponse('Brand not found', 404);

  const data = doc.data() as Omit<BrandProfile, 'id'>;
  if (data.userId !== uid) return errorResponse('Forbidden', 403);

  return NextResponse.json({ data: { id: doc.id, ...data } });
}

// PATCH /api/brands/[brandId]
export async function PATCH(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const doc = await db.collection('brands').doc(brandId).get();

  if (!doc.exists) return errorResponse('Brand not found', 404);
  if ((doc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  let body: Partial<Pick<BrandProfile, 'name' | 'keywords' | 'officialDomains' | 'watchWords' | 'safeWords'>>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const updatedAt = new Date();
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (body.name) updates.name = body.name.trim();
  if (body.keywords) updates.keywords = body.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (body.officialDomains) updates.officialDomains = body.officialDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (body.watchWords !== undefined) updates.watchWords = body.watchWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (body.safeWords !== undefined) updates.safeWords = body.safeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);

  await db.collection('brands').doc(brandId).update(updates);

  // Substitute a real Date for the sentinel so the response is serialisable
  return NextResponse.json({ data: { id: brandId, ...doc.data(), ...updates, updatedAt } });
}

// DELETE /api/brands/[brandId]
export async function DELETE(request: NextRequest, { params }: Params) {
  const { uid, error } = requireAuth(request);
  if (error) return error;

  const { brandId } = await params;
  const doc = await db.collection('brands').doc(brandId).get();

  if (!doc.exists) return errorResponse('Brand not found', 404);
  if ((doc.data() as BrandProfile).userId !== uid) return errorResponse('Forbidden', 403);

  await db.collection('brands').doc(brandId).delete();

  return new NextResponse(null, { status: 204 });
}
