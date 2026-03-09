import { buildAppBaseUrl, buildBrandedEmailFrame, escapeHtml } from './email-branding';

export const EMAIL_VERIFICATION_TOKEN_MAX_AGE_SECONDS = 60 * 60;
export const EMAIL_VERIFICATION_TOKEN_MAX_AGE_LABEL = '1 hour';
export const EMAIL_VERIFICATION_REQUEST_SUCCESS_MESSAGE = 'Verification email sent';

export function buildEmailVerificationLink(token: string): string {
  return `${buildAppBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

export function buildEmailVerificationContent(verificationLink: string) {
  const expiryLabel = EMAIL_VERIFICATION_TOKEN_MAX_AGE_LABEL;

  const text = [
    'DoppelSpotter email verification',
    '',
    `Please verify your email address to activate your account. This link is valid for ${expiryLabel}.`,
    '',
    `Verify your email: ${verificationLink}`,
    '',
    'If you did not create a DoppelSpotter account, you can safely ignore this email.',
  ].join('\n');

  const html = buildBrandedEmailFrame({
    title: 'Verify your email',
    bodyHtml: `
      <div style="margin:0 0 24px;border:1px solid #e0f2fe;border-radius:16px;background:#f0f9ff;padding:20px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">Account setup</div>
        <div style="margin-top:8px;font-size:24px;font-weight:700;color:#111827;">Confirm your email address</div>
        <div style="margin-top:8px;font-size:14px;line-height:1.6;color:#0c4a6e;">
          Use the button below to verify your email and activate your account. The link expires in ${escapeHtml(expiryLabel)}.
        </div>
      </div>

      <div style="margin-bottom:24px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">What happens next</div>
        <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:#111827;">
          Once you verify your email, you can sign in and start using DoppelSpotter.
        </p>
      </div>

      <div style="margin-top:32px;">
        <a
          href="${escapeHtml(verificationLink)}"
          style="display:inline-block;border-radius:9999px;background:#0284c7;padding:13px 20px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;"
        >
          Verify email address
        </a>
        <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
          If the button does not work, open this link:<br />
          <a href="${escapeHtml(verificationLink)}" style="color:#111827;text-decoration:underline;word-break:break-all;">${escapeHtml(verificationLink)}</a>
        </p>
        <p style="margin:16px 0 0;border-left:3px solid #0ea5e9;padding-left:12px;font-size:13px;line-height:1.6;color:#0c4a6e;">
          If you did not create a DoppelSpotter account, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  return {
    subject: 'Verify your DoppelSpotter email address',
    html,
    text,
  };
}
