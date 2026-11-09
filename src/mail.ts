import type { AccountManager } from './accounts.js';
import { appendToSentFolder } from './sent.js';
import { composeRaw, defaultSendRaw, type SendDeps } from './tools/send.js';

export interface SendMailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body */
  text: string;
  html?: string;
  /** Absolute file paths to attach. Must be trusted: nodemailer reads them from disk. */
  attachments?: string[];
  /** Reply-To header address */
  replyTo?: string;
  /** Message-ID header, passed straight to nodemailer (include the angle brackets) */
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** File a copy in \Sent after sending. Defaults to the account's `appendToSent`. */
  appendToSent?: boolean;
}

export interface SendMailResult {
  from: string;
  /** to + cc + bcc, in that order: the SMTP envelope recipients */
  recipients: string[];
  /** The RFC 822 message that was sent */
  raw: Buffer;
  /** Whether a copy was filed in Sent. False when not requested or when it failed. */
  sentAppended: boolean;
  /** Folder the copy was saved to, when sentAppended is true */
  sentPath?: string;
  /** Why the Sent copy was not saved. The message WAS sent: never resend on this. */
  sentAppendError?: string;
}

function assertAddresses(label: string, addresses: Array<string | undefined>): void {
  for (const a of addresses) {
    if (a !== undefined && /[\r\n]/.test(a)) {
      throw new Error(`Invalid ${label} address: CR or LF is not allowed.`);
    }
  }
}

/**
 * Send a message from a configured account over its SMTP settings, using the
 * same composer, transport and OAuth/password auth as the `email_send` tool.
 * Does not resolve replies; pass inReplyTo and references yourself for
 * threading. Rejects before sending on bad input; once the SMTP send has
 * succeeded it never throws (a failed Sent copy is reported in the result).
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
  assertAddresses('from', [acct.user]);
  assertAddresses('to', options.to);
  assertAddresses('cc', cc);
  assertAddresses('bcc', bcc);
  assertAddresses('replyTo', [options.replyTo]);

  const raw = await composeRaw({
    from: acct.user,
    to: options.to,
    cc: cc.length > 0 ? cc : undefined,
    replyTo: options.replyTo,
    subject: options.subject,
    text: options.text,
    html: options.html || undefined,
    messageId: options.messageId,
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

  const result: SendMailResult = { from: acct.user, recipients, raw, sentAppended: false };
  if (options.appendToSent ?? acct.appendToSent) {
    const res = await appendToSentFolder(manager, account, raw);
    if (res.path) {
      result.sentAppended = true;
      result.sentPath = res.path;
    } else {
      result.sentAppendError = res.error;
    }
  }
  return result;
}
