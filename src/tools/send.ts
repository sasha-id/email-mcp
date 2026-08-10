import nodemailer, { type SendMailOptions } from 'nodemailer';
import PostalMime from 'postal-mime';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager, SmtpAuth } from '../accounts.js';
import { fail, ok, run } from './helpers.js';

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: SmtpAuth;
}

export interface SendDeps {
  sendRaw?: (
    transport: SmtpTransportOptions,
    envelope: { from: string; to: string[] },
    raw: Buffer,
  ) => Promise<void>;
}

/** Compose an RFC 822 message via nodemailer's stream transport (no SMTP involved). */
async function composeRaw(mail: SendMailOptions): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await composer.sendMail(mail);
  return info.message as Buffer;
}

export const defaultSendRaw: NonNullable<SendDeps['sendRaw']> = async (transport, envelope, raw) => {
  // No autoSelectFamily here, unlike IMAP: nodemailer resolves the hostname itself and
  // connects to a single literal address, so Node never runs a happy-eyeballs race.
  const smtp = nodemailer.createTransport({
    ...transport,
    requireTLS: !transport.secure,
  } as never);
  try {
    await smtp.sendMail({ envelope, raw });
  } finally {
    smtp.close();
  }
};

export function registerSend(server: McpServer, manager: AccountManager, deps: SendDeps = {}): void {
  const sendRaw = deps.sendRaw ?? defaultSendRaw;
  server.registerTool(
    'email_send',
    {
      description:
        'Send an email via SMTP from a configured account. ALWAYS confirm with the user before sending. To reply in-thread, pass replyTo — recipients then default to the original sender (Reply-To preferred) and the subject to "Re: …".',
      inputSchema: {
        account: z.string(),
        to: z.array(z.string()).default([]),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        subject: z.string().optional().describe('Required unless replyTo is given'),
        text: z.string().describe('Plain-text body'),
        html: z.string().optional().describe('Optional HTML body'),
        attachments: z.array(z.string()).default([]).describe('Absolute file paths to attach'),
        replyTo: z
          .object({ mailbox: z.string().default('INBOX'), uid: z.number().int().positive() })
          .optional()
          .describe('Message being replied to'),
      },
    },
    async ({ account, to, cc, bcc, subject, text, html, attachments, replyTo }) =>
      run(async () => {
        const acct = manager.account(account);
        if (!acct.smtp) return fail(`Account "${account}" has no smtp configuration.`);
        const smtpConfig = acct.smtp;

        let inReplyTo: string | undefined;
        let references: string | undefined;
        if (replyTo) {
          const original = await manager.withMailbox(account, replyTo.mailbox, async client => {
            // Threading needs five headers, not the source: a reply target can
            // carry tens of MB of attachments, and a full-source fetch of it is
            // slow enough to outlive any sane timeout on a throttled link.
            const msg = await client.fetchOne(
              String(replyTo.uid),
              { headers: ['message-id', 'references', 'subject', 'from', 'reply-to'] },
              { uid: true },
            );
            const headers = msg ? (msg as { headers?: Buffer }).headers : undefined;
            if (!headers) throw new Error(`replyTo uid ${replyTo.uid} not found in ${account}/${replyTo.mailbox}`);
            return PostalMime.parse(headers);
          });
          if (original.messageId) {
            inReplyTo = original.messageId;
            references = [original.references, original.messageId].filter(Boolean).join(' ');
          }
          if (to.length === 0) {
            const sender = original.replyTo?.[0] ?? original.from;
            const address = sender && 'address' in sender ? sender.address : undefined;
            if (address) to = [address];
          }
          if (!subject) {
            const orig = original.subject ?? '';
            subject = /^re:/i.test(orig) ? orig : `Re: ${orig}`;
          }
        }
        if (to.length === 0) return fail('No recipients — pass to[] or a replyTo message with a sender.');
        if (!subject) return fail('subject is required when not replying.');

        const raw = await composeRaw({
          from: acct.user,
          to,
          cc: cc.length > 0 ? cc : undefined,
          subject,
          text,
          html: html || undefined,
          inReplyTo,
          references,
          attachments: attachments.length > 0 ? attachments.map(path => ({ path })) : undefined,
        });

        await sendRaw(
          {
            host: smtpConfig.host,
            port: smtpConfig.port,
            secure: smtpConfig.secure ?? smtpConfig.port === 465,
            auth: await manager.smtpAuth(account),
          },
          { from: acct.user, to: [...to, ...cc, ...bcc] },
          raw,
        );

        let appended = '';
        if (acct.appendToSent) {
          try {
            // retry: false — APPEND is not idempotent; after an ambiguous
            // drop, re-appending could file a duplicate copy in Sent.
            appended = await manager.withClient(
              account,
              async client => {
                const folders = await client.list();
                const sent = folders.find(f => f.specialUse === '\\Sent');
                if (!sent) return ' (no \\Sent folder found — copy not saved)';
                await client.append(sent.path, raw, ['\\Seen']);
                return ` (saved to ${sent.path})`;
              },
              { retry: false },
            );
          } catch (err) {
            appended = ` (sent, but saving to Sent failed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }
        return ok(`Sent "${subject}" from ${account} to ${to.join(', ')}.${appended}`);
      }),
  );
}
