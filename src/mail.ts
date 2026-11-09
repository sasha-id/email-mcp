import type { AccountManager } from './accounts.js';
import { composeRaw, defaultSendRaw, type SendDeps } from './tools/send.js';

export interface SendMailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body */
  text: string;
  html?: string;
  /** Absolute file paths to attach */
  attachments?: string[];
  inReplyTo?: string;
  references?: string;
}

export interface SendMailResult {
  from: string;
  /** to + cc + bcc, in that order: the SMTP envelope recipients */
  recipients: string[];
  /** The RFC 822 message that was sent */
  raw: Buffer;
}

/**
 * Send a message from a configured account over its SMTP settings, using the
 * same composer, transport and OAuth/password auth as the `email_send` tool.
 * Does not file a copy in Sent and does not resolve replies; pass inReplyTo
 * and references yourself for threading.
 */
export async function sendMail(
  manager: AccountManager,
  account: string,
  options: SendMailOptions,
  deps: SendDeps = {},
): Promise<SendMailResult> {
  const acct = manager.account(account);
  if (!acct.smtp) throw new Error(`Account "${account}" has no smtp configuration.`);
  const cc = options.cc ?? [];
  const bcc = options.bcc ?? [];
  if (options.to.length === 0) throw new Error('No recipients: pass at least one address in to.');
  if (!options.subject) throw new Error('subject is required.');

  const raw = await composeRaw({
    from: acct.user,
    to: options.to,
    cc: cc.length > 0 ? cc : undefined,
    subject: options.subject,
    text: options.text,
    html: options.html || undefined,
    inReplyTo: options.inReplyTo,
    references: options.references,
    attachments: options.attachments?.length ? options.attachments.map(path => ({ path })) : undefined,
  });
  const recipients = [...options.to, ...cc, ...bcc];
  await (deps.sendRaw ?? defaultSendRaw)(
    {
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.secure ?? acct.smtp.port === 465,
      auth: await manager.smtpAuth(account),
    },
    { from: acct.user, to: recipients },
    raw,
  );
  return { from: acct.user, recipients, raw };
}
