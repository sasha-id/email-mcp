import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../accounts.js';
import { fail, ok, run } from './helpers.js';

export function registerAuthenticate(server: McpServer, manager: AccountManager): void {
  server.registerTool(
    'email_authenticate',
    {
      description:
        'Start or check Microsoft 365 device-code authentication for an m365-oauth account. Returns a URL and code for the user to enter in a browser; call again to check progress.',
      inputSchema: {
        account: z.string(),
      },
    },
    async ({ account }) =>
      run(async () => {
        const acct = manager.account(account);
        if (acct.auth.type !== 'm365-oauth') {
          return fail(`Account "${account}" uses password auth — nothing to authenticate.`);
        }
        const auth = manager.m365(account);

        const status = auth.flowStatus();
        if (status.state === 'pending') {
          return ok(
            `Authentication still pending for "${account}" — open ${status.verificationUri} and enter code ${status.userCode}, then call email_authenticate again.`,
          );
        }
        if (status.state === 'completed') {
          return ok(`Authentication completed for "${account}" — email tools are ready.`);
        }
        if (status.state === 'failed') {
          return fail(`Authentication failed for "${account}": ${status.error}. Call email_authenticate again to retry.`);
        }

        try {
          await auth.getAccessToken();
          return ok(`Account "${account}" already has a valid token.`);
        } catch {
          // no valid token — start a new device flow below
        }

        const { verificationUri, userCode } = await auth.startDeviceFlow();
        return ok(
          `To authenticate "${account}": open ${verificationUri} and enter code ${userCode}. ` +
            `Polling in the background — call email_authenticate again to check status.`,
        );
      }),
  );
}
