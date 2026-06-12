import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { ok, run } from './helpers.js';

export function registerDelete(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_delete',
    {
      description:
        'Delete messages. Default: move to the account\'s \\Trash folder (recoverable). permanent: true expunges immediately — irreversible, confirm with the user first.',
      inputSchema: {
        account: z.string(),
        mailbox: z.string().default('INBOX'),
        uids: z.array(z.number().int().positive()).min(1),
        permanent: z.boolean().default(false),
      },
    },
    async ({ account, mailbox, uids, permanent }) =>
      run(async () => {
        const text = await manager.withMailbox(account, mailbox, async client => {
          if (permanent) {
            const deleted = await client.messageDelete(uids, { uid: true });
            if (!deleted) throw new Error(`Permanent delete failed in ${account}/${mailbox}.`);
            return `Permanently deleted ${uids.length} message(s) from ${account}/${mailbox}.`;
          }
          const folders = await client.list();
          const trash = folders.find(f => f.specialUse === '\\Trash');
          if (!trash) {
            throw new Error(
              `No \\Trash folder advertised by ${account} — use email_move to an explicit folder, or permanent: true.`,
            );
          }
          if (trash.path === mailbox) {
            throw new Error(`${mailbox} is already the trash folder — use permanent: true to expunge.`);
          }
          const moved = await client.messageMove(uids, trash.path, { uid: true });
          if (!moved) throw new Error(`Move to ${trash.path} failed in ${account}/${mailbox}.`);
          return `Moved ${uids.length} message(s) from ${account}/${mailbox} to ${trash.path}.`;
        });
        return ok(text);
      }),
  );
}
