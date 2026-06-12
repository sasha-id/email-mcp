import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { ok, run } from './helpers.js';

export function registerListFolders(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_list_folders',
    {
      description:
        'List folders/mailboxes for an account with special-use flags (\\Trash, \\Sent, \\Junk…) and unseen/total message counts.',
      inputSchema: {
        account: z.string().describe('Account name from email_list_accounts'),
      },
    },
    async ({ account }) =>
      run(async () => {
        const text = await manager.withClient(account, async client => {
          const folders = await client.list();
          const lines: string[] = [];
          // byte-order sort — localeCompare puts '[Gmail]' before 'INBOX' under ICU collation
          for (const folder of [...folders].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
            let counts = '';
            try {
              const st = await client.status(folder.path, { messages: true, unseen: true });
              counts = ` — ${st.unseen ?? 0} unseen / ${st.messages ?? 0} total`;
            } catch {
              // \Noselect and similar folders do not support STATUS — show the path anyway
            }
            const special = folder.specialUse ? ` [${folder.specialUse}]` : '';
            lines.push(`${folder.path}${special}${counts}`);
          }
          return lines.length > 0 ? lines.join('\n') : '(no folders)';
        });
        return ok(text);
      }),
  );
}
