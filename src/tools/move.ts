import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { ok, run } from './helpers.js';

export function registerMove(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_move',
    {
      description: 'Move a batch of messages to another folder in the same account.',
      inputSchema: {
        account: z.string(),
        mailbox: z.string().default('INBOX').describe('Source mailbox'),
        uids: z.array(z.number().int().positive()).min(1),
        target: z.string().describe('Destination mailbox path from email_list_folders'),
      },
    },
    async ({ account, mailbox, uids, target }) =>
      run(async () => {
        await manager.withMailbox(account, mailbox, async client => {
          await client.messageMove(uids, target, { uid: true });
        });
        return ok(`Moved ${uids.length} message(s) from ${mailbox} to ${target} in ${account}.`);
      }),
  );
}
