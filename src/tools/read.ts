import { createWriteStream, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import PostalMime, { type Email } from 'postal-mime';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapFlow } from 'imapflow';
import type { AccountManager } from '../accounts.js';
import { htmlToText, renderMessage, type AddressLike } from '../render.js';
import { analyzeStructure, type MessageStructure, type StructureNode } from '../structure.js';
import { fail, ok, run } from './helpers.js';

/** Cap on the (still transfer-encoded) body part pulled for display. */
const BODY_FETCH_MAX = 100_000;

interface FetchedMessage {
  headers: Email;
  structure: MessageStructure;
}

/**
 * Fetch headers + BODYSTRUCTURE (a few KB, regardless of message size) under
 * one mailbox lock, then hand off to fn for whichever part downloads it needs.
 * Never pulls the full source: a message with tens of MB of attachments costs
 * the same as a bare text message.
 */
async function withMessage<T>(
  manager: AccountManager,
  account: string,
  mailbox: string,
  uid: number,
  fn: (client: ImapFlow, msg: FetchedMessage) => Promise<T>,
): Promise<T> {
  return manager.withMailbox(account, mailbox, async client => {
    const meta = await client.fetchOne(String(uid), { bodyStructure: true, headers: true }, { uid: true });
    const m = meta as { headers?: Buffer; bodyStructure?: StructureNode } | false;
    if (!m || !m.headers || !m.bodyStructure) throw new Error(`uid ${uid} not found in ${account}/${mailbox}`);
    const headers = await PostalMime.parse(m.headers);
    return fn(client, { headers, structure: analyzeStructure(m.bodyStructure) });
  });
}

async function downloadToBuffer(client: ImapFlow, uid: number, part: string, maxBytes: number): Promise<Buffer> {
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
  const chunks: Buffer[] = [];
  for await (const chunk of content as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function registerRead(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_read',
    {
      description:
        'Read one message by uid: headers, text body (HTML stripped when no text part, truncated at 50 KB), and attachment metadata. Use email_attachment to save attachment content.',
      inputSchema: {
        account: z.string().describe('Account name from email_list_accounts'),
        mailbox: z.string().default('INBOX'),
        uid: z.number().int().positive().describe('uid from email_search'),
      },
    },
    async ({ account, mailbox, uid }) =>
      run(async () => {
        const text = await withMessage(manager, account, mailbox, uid, async (client, { headers, structure }) => {
          let body = '(no body)';
          if (structure.body) {
            const raw = await downloadToBuffer(client, uid, structure.body.part, BODY_FETCH_MAX);
            body = structure.body.isHtml ? htmlToText(raw.toString('utf-8')) : raw.toString('utf-8');
          }
          return renderMessage({
            from: headers.from as AddressLike,
            to: headers.to as AddressLike[] | undefined,
            cc: headers.cc as AddressLike[] | undefined,
            date: headers.date,
            subject: headers.subject,
            messageId: headers.messageId,
            inReplyTo: headers.inReplyTo,
            body,
            attachments: structure.attachments,
          });
        });
        return ok(text);
      }),
  );

  server.registerTool(
    'email_attachment',
    {
      description:
        'Save one attachment of a message to disk. Identify it by index (from email_read) or filename.',
      inputSchema: {
        account: z.string(),
        mailbox: z.string().default('INBOX'),
        uid: z.number().int().positive(),
        index: z.number().int().min(0).optional().describe('Attachment index from email_read'),
        filename: z.string().optional(),
        savePath: z.string().describe('Absolute path to write the attachment to'),
      },
    },
    async ({ account, mailbox, uid, index, filename, savePath }) =>
      run(async () => {
        if (index === undefined && filename === undefined) {
          return fail('Provide index or filename to pick an attachment.');
        }
        if (!isAbsolute(savePath)) {
          return fail('savePath must be an absolute path.');
        }
        return withMessage(manager, account, mailbox, uid, async (client, { structure }) => {
          const attachment =
            index !== undefined ? structure.attachments[index] : structure.attachments.find(a => a.filename === filename);
          if (!attachment) {
            const available =
              structure.attachments.map((a, i) => `[${i}] ${a.filename ?? '(unnamed)'}`).join(', ') || '(none)';
            return fail(`Attachment not found. Available: ${available}`);
          }
          // Stream the single part straight to disk: constant memory, and a big
          // attachment no longer forces a full-message transfer first.
          const { content } = await client.download(String(uid), attachment.part, { uid: true });
          await pipeline(content as AsyncIterable<Buffer>, createWriteStream(savePath));
          const bytes = statSync(savePath).size;
          return ok(`Wrote ${bytes} bytes to ${savePath} (${attachment.mimeType})`);
        });
      }),
  );
}
