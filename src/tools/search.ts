import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { summarizeMessage, type MessageSummary } from '../render.js';
import { buildSearchQuery } from '../search.js';
import { ok, run } from './helpers.js';

export function registerSearch(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_search',
    {
      description:
        'Search messages in one account/mailbox by body text, sender, recipient, subject, date range, and flags. Returns newest-first one-line summaries whose uid values feed email_read/email_mark/email_move/email_delete. For cross-account search, call once per account.',
      inputSchema: {
        account: z.string().describe('Account name from email_list_accounts'),
        mailbox: z.string().default('INBOX'),
        text: z.string().optional().describe('Match against message body'),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        since: z.string().optional().describe('YYYY-MM-DD (inclusive)'),
        before: z.string().optional().describe('YYYY-MM-DD (exclusive)'),
        seen: z.boolean().optional().describe('true = only read, false = only unread'),
        flagged: z.boolean().optional(),
        limit: z.number().int().positive().max(200).default(20),
      },
    },
    async ({ account, mailbox, limit, ...params }) =>
      run(async () => {
        const text = await manager.withMailbox(account, mailbox, async client => {
          const uids = (await client.search(buildSearchQuery(params), { uid: true })) || [];
          if (uids.length === 0) return `No matches in ${account}/${mailbox}.`;
          const selected = [...uids].sort((a, b) => b - a).slice(0, limit);
          const messages: MessageSummary[] = [];
          for await (const msg of client.fetch(
            selected,
            { envelope: true, flags: true, size: true, uid: true },
            { uid: true },
          )) {
            messages.push(msg as unknown as MessageSummary);
          }
          messages.sort((a, b) => b.uid - a.uid);
          return [
            `${uids.length} match(es) in ${account}/${mailbox}, showing ${messages.length} (newest first):`,
            ...messages.map(summarizeMessage),
          ].join('\n');
        });
        return ok(text);
      }),
  );
}
