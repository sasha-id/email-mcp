import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerListAccounts } from '../src/tools/accounts.js';
import { FakeImap, managerWith } from './fakes.js';
import { connectServer, isError, textOf } from './mcp.js';

describe('email_list_accounts', () => {
  it('lists accounts with auth kind and state, no secrets', async () => {
    const manager = managerWith(new FakeImap(), { tokenDir: mkdtempSync(join(tmpdir(), 'email-mcp-tok-')) });
    const client = await connectServer(server => registerListAccounts(server, manager));
    const result = await client.callTool({ name: 'email_list_accounts', arguments: {} });
    const text = textOf(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('personal: me@example.com — imap mail.example.com:993 — password (literal)');
    expect(text).toContain('work: me@corp.example — imap outlook.office365.com:993 — m365-oauth (NOT authenticated');
    expect(text).not.toContain('hunter2');
  });
});
