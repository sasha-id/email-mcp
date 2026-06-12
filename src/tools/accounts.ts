import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { ok, run } from './helpers.js';

export function registerListAccounts(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_list_accounts',
    {
      description:
        'List configured email accounts with host and authentication state. Never returns secrets. Call this first to learn valid account names.',
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const lines = manager.accountNames().map(name => {
          const account = manager.account(name);
          let auth: string;
          if (account.auth.type === 'password') {
            auth = account.auth.pass.startsWith('op://') ? 'password (1Password ref)' : 'password (literal)';
          } else {
            const state = manager.m365(name).tokenState();
            auth =
              state === 'none'
                ? `m365-oauth (NOT authenticated — run email_authenticate with account "${name}")`
                : state === 'valid'
                  ? 'm365-oauth (token valid)'
                  : 'm365-oauth (token cached — will refresh on next use)';
          }
          return `${name}: ${account.user} — imap ${account.imap.host}:${account.imap.port} — ${auth}`;
        });
        return ok(lines.join('\n'));
      }),
  );
}
