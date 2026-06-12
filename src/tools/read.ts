import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import PostalMime, { type Email } from 'postal-mime';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { renderEmail } from '../render.js';
import { fail, ok, run } from './helpers.js';

export async function fetchParsed(
  manager: AccountManager,
  account: string,
  mailbox: string,
  uid: number,
): Promise<Email> {
  return manager.withMailbox(account, mailbox, async client => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    const source = msg ? (msg as { source?: Buffer }).source : undefined;
    if (!source) throw new Error(`uid ${uid} not found in ${account}/${mailbox}`);
    return PostalMime.parse(source);
  });
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
        const parsed = await fetchParsed(manager, account, mailbox, uid);
        return ok(renderEmail(parsed));
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
        const parsed = await fetchParsed(manager, account, mailbox, uid);
        const attachment =
          index !== undefined ? parsed.attachments[index] : parsed.attachments.find(a => a.filename === filename);
        if (!attachment) {
          const available =
            parsed.attachments.map((a, i) => `[${i}] ${a.filename ?? '(unnamed)'}`).join(', ') || '(none)';
          return fail(`Attachment not found. Available: ${available}`);
        }
        const data =
          typeof attachment.content === 'string'
            ? Buffer.from(attachment.content, 'utf8')
            : attachment.content instanceof ArrayBuffer
              ? Buffer.from(attachment.content)
              : Buffer.from(attachment.content.buffer, attachment.content.byteOffset, attachment.content.byteLength);
        writeFileSync(savePath, data);
        return ok(`Wrote ${data.byteLength} bytes to ${savePath} (${attachment.mimeType})`);
      }),
  );
}
