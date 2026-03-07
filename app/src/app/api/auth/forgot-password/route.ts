import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { signPasswordResetToken } from '@/lib/auth/jwt';
import { sendMailerSendEmail } from '@/lib/mailersend';
import {
  MAILERSEND_FROM_EMAIL,
  MAILERSEND_FROM_NAME,
  normaliseEmail,
  normalizeEmailErrorMessage,
} from '@/lib/email-branding';
import {
  buildPasswordResetEmailContent,
  buildPasswordResetLink,
  PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE,
} from '@/lib/password-reset';
import type { UserRecord } from '@/lib/types';

export async function POST(request: NextRequest) {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE });
  }

  const normalizedEmail = normaliseEmail(body.email);
  if (!normalizedEmail) {
    return NextResponse.json({ message: PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE });
  }

  try {
    const snapshot = await db
      .collection('users')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const userDoc = snapshot.docs[0];
      const user = userDoc.data() as Pick<UserRecord, 'email' | 'sessionVersion'>;
      const token = signPasswordResetToken(userDoc.id, normalizedEmail, user.sessionVersion ?? 0);
      const resetLink = buildPasswordResetLink(token);
      const content = buildPasswordResetEmailContent(resetLink);

      await sendMailerSendEmail({
        from: {
          email: MAILERSEND_FROM_EMAIL,
          name: MAILERSEND_FROM_NAME,
        },
        to: [{ email: normalizedEmail }],
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }
  } catch (error) {
    const message = normalizeEmailErrorMessage(error);
    console.error(`[forgot-password] Failed to handle reset email for ${normalizedEmail}: ${message}`, error);
  }

  return NextResponse.json({ message: PASSWORD_RESET_REQUEST_SUCCESS_MESSAGE });
}
