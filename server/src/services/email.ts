/**
 * Transactional email.
 *
 * In development messages are captured in the notifications table and logged so
 * the whole invoice/reminder flow is testable without an SMTP account. Set
 * SMTP_URL to an HTTP relay (or swap `deliver` for nodemailer) in production.
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { config } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachmentName?: string;
  attachment?: Buffer;
}

export interface EmailResult {
  status: 'sent' | 'queued' | 'skipped';
  provider: string;
  messageId: string;
}

export async function sendEmail(db: DB, tenantId: string, message: EmailMessage): Promise<EmailResult> {
  const messageId = newId();
  let status: EmailResult['status'] = 'queued';
  let provider = 'capture';

  if (config.smtpUrl.startsWith('http')) {
    try {
      const res = await fetch(config.smtpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...message, attachment: message.attachment?.toString('base64') }),
      });
      status = res.ok ? 'sent' : 'queued';
      provider = 'relay';
    } catch {
      status = 'queued';
      provider = 'relay';
    }
  } else if (config.isProd) {
    status = 'queued';
    provider = 'unconfigured';
  }

  await db.run(
    `INSERT INTO notifications (id, tenant_id, user_id, title, body, level, created_at)
     VALUES (?, ?, NULL, ?, ?, 'email', ?)`,
    [messageId, tenantId, message.subject, `${message.to}\n\n${message.text}`, new Date().toISOString()],
  );
  return { status, provider, messageId };
}

export function invoiceEmail(input: {
  companyName: string;
  customerName: string;
  number: string;
  total: string;
  dueDate: string;
  link: string;
  message?: string;
}): EmailMessage & { to: string } {
  const text = [
    `Hi ${input.customerName},`,
    '',
    input.message ?? `Please find invoice ${input.number} for ${input.total}, due ${input.dueDate}.`,
    '',
    `View and pay online: ${input.link}`,
    '',
    `Thank you,`,
    input.companyName,
  ].join('\n');
  return {
    to: '',
    subject: `Invoice ${input.number} from ${input.companyName}`,
    text,
    html: `<p>Hi ${escapeHtml(input.customerName)},</p>
<p>${escapeHtml(input.message ?? `Please find invoice ${input.number} for ${input.total}, due ${input.dueDate}.`)}</p>
<p><a href="${escapeHtml(input.link)}">View and pay invoice ${escapeHtml(input.number)}</a></p>
<p>Thank you,<br/>${escapeHtml(input.companyName)}</p>`,
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
