import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/firestore';
import { signEmailVerificationToken } from '@/lib/auth/jwt';
import { sendMailerSendEmail } from '@/lib/mailersend';
import {
  MAILERSEND_FROM_EMAIL,
  MAILERSEND_FROM_NAME,
  normaliseEmail,
  normalizeEmailErrorMessage,
} from '@/lib/email-branding';
import {
  buildEmailVerificationContent,
  buildEmailVerificationLink,
  EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE,
} from '@/lib/email-verification';
import type { UserRecord } from '@/lib/types';

export async function POST(request: NextRequest) {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE });
  }

  const normalizedEmail = normaliseEmail(body.email);
  if (!normalizedEmail) {
    return NextResponse.json({ message: EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE });
  }

  try {
    const snapshot = await db
      .collection('users')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const userDoc = snapshot.docs[0];
      const user = userDoc.data() as Pick<UserRecord, 'emailVerified'>;

      // Only resend if the account is explicitly unverified — never resend to already-verified users
      if (user.emailVerified === false) {
        const verificationToken = signEmailVerificationToken(userDoc.id, normalizedEmail);
        const verificationLink = buildEmailVerificationLink(verificationToken);
        const content = buildEmailVerificationContent(verificationLink);

        await sendMailerSendEmail({
          from: { email: MAILERSEND_FROM_EMAIL, name: MAILERSEND_FROM_NAME },
          to: [{ email: normalizedEmail }],
          subject: content.subject,
          html: content.html,
          text: content.text,
        });
      }
    }
  } catch (error) {
    const message = normalizeEmailErrorMessage(error);
    console.error(`[resend-verification] Failed for ${normalizedEmail}: ${message}`, error);
  }

  return NextResponse.json({ message: EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE });
}
