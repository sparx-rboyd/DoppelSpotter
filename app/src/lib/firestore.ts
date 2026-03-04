import { Firestore } from '@google-cloud/firestore';

// On Cloud Run, ADC (Application Default Credentials) is used automatically
// via the Compute Engine default service account — no key file needed.
// For local development, set GOOGLE_APPLICATION_CREDENTIALS to the path of a
// service account key JSON file that has Firestore access.
export const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID ?? '(default)',
});
