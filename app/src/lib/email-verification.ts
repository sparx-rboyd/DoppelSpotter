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
      <div style="margin:0 0 18px;border:1px solid #dbeafe;border-radius:16px;background:linear-gradient(180deg,#f8fbff 0%,#eff6ff 100%);padding:18px 18px 16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">Account setup</div>
        <div style="margin-top:6px;font-size:22px;line-height:1.2;font-weight:400;color:#0369a1;">Confirm your email address</div>
        <div style="margin-top:8px;font-size:14px;line-height:1.5;color:#677180;">
          Use the button below to verify your email and activate your account. The link expires in ${escapeHtml(expiryLabel)}.
        </div>
      </div>

      <div style="margin-bottom:18px;border:1px solid #dbeafe;border-radius:14px;background:#f8fbff;padding:16px 18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0369a1;">What happens next</div>
        <p style="margin:10px 0 0;font-size:14px;line-height:1.5;color:#677180;">
          Once you verify your email, you can sign in and start using DoppelSpotter.
        </p>
      </div>

      <div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:18px;">
        <a
          href="${escapeHtml(verificationLink)}"
          style="display:inline-block;border-radius:9999px;background:#0284c7;padding:12px 18px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;"
        >
          Verify email address
        </a>
        <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
          If the button does not work, open this link:<br />
          <a href="${escapeHtml(verificationLink)}" style="color:#0f172a;text-decoration:underline;word-break:break-all;">${escapeHtml(verificationLink)}</a>
        </p>
        <p style="margin:12px 0 0;border-left:3px solid #38bdf8;padding-left:12px;font-size:12px;line-height:1.6;color:#475569;">
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
