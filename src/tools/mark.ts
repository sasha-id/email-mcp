import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { fail, ok, run } from './helpers.js';

const FLAG_VALUES = ['\\Seen', '\\Flagged', '\\Answered'] as const;

export function registerMark(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_mark',
    {
      description:
        'Add/remove flags (\\Seen, \\Flagged, \\Answered) on a batch of messages. Use add: ["\\\\Seen"] to mark read, remove: ["\\\\Seen"] to mark unread.',
      inputSchema: {
        account: z.string(),
        mailbox: z.string().default('INBOX'),
        uids: z.array(z.number().int().positive()).min(1),
        add: z.array(z.enum(FLAG_VALUES)).default([]),
        remove: z.array(z.enum(FLAG_VALUES)).default([]),
      },
    },
    async ({ account, mailbox, uids, add, remove }) =>
      run(async () => {
        if (add.length === 0 && remove.length === 0) {
          return fail('Provide flags to add and/or remove.');
        }
        await manager.withMailbox(account, mailbox, async client => {
          if (add.length > 0 && !(await client.messageFlagsAdd(uids, [...add], { uid: true }))) {
            throw new Error(`Failed to add flags in ${account}/${mailbox}.`);
          }
          if (remove.length > 0 && !(await client.messageFlagsRemove(uids, [...remove], { uid: true }))) {
            throw new Error(`Failed to remove flags in ${account}/${mailbox}.`);
          }
        });
        const did = [
          add.length > 0 ? `added ${add.join(' ')}` : '',
          remove.length > 0 ? `removed ${remove.join(' ')}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return ok(`Updated ${uids.length} message(s) in ${account}/${mailbox}: ${did}.`);
      }),
  );
}
