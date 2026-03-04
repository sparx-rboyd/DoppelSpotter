import { NextResponse } from 'next/server';

// Signup is disabled while the app is in development.
// Use the `npm run add-user` CLI script to create accounts locally.
export function POST() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
