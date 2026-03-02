import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminApp(): App {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountKey) {
    const serviceAccount = JSON.parse(serviceAccountKey);
    return initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  // In Cloud Run with Workload Identity or ADC, no explicit credentials needed
  return initializeApp({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  });
}

const adminApp = getAdminApp();
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

export { adminApp, adminAuth, adminDb };

// ─── Auth helpers ───────────────────────────────────────────────────────────

export async function verifyIdToken(idToken: string) {
  return adminAuth.verifyIdToken(idToken);
}

/**
 * Extract and verify the Bearer token from an Authorization header.
 * Returns the decoded token or null if missing/invalid.
 */
export async function verifyAuthHeader(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    return await verifyIdToken(token);
  } catch {
    return null;
  }
}
