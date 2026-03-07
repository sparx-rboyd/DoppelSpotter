const MAILERSEND_BASE_URL = 'https://api.mailersend.com/v1';

export interface MailerSendRecipient {
  email: string;
  name?: string;
}

export interface SendMailerSendEmailInput {
  from: MailerSendRecipient;
  to: MailerSendRecipient[];
  subject: string;
  html: string;
  text: string;
}

export interface SendMailerSendEmailResult {
  messageId: string | null;
}

export async function sendMailerSendEmail(input: SendMailerSendEmailInput): Promise<SendMailerSendEmailResult> {
  const apiToken = process.env.MAILERSEND_API_TOKEN;
  if (!apiToken) {
    throw new Error('MAILERSEND_API_TOKEN is not set');
  }

  const response = await fetch(`${MAILERSEND_BASE_URL}/email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MailerSend error ${response.status}: ${body}`);
  }

  return {
    messageId: response.headers.get('x-message-id'),
  };
}
