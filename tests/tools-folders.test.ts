import { describe, expect, it } from 'vitest';
import { registerListFolders } from '../src/tools/folders.js';
import { FakeImap, managerWith } from './fakes.js';
import { connectServer, isError, textOf } from './mcp.js';

describe('email_list_folders', () => {
  it('lists folders sorted with special-use flags and counts; tolerates STATUS failures', async () => {
    const fake = new FakeImap();
    fake.folders = [
      { path: 'Trash', specialUse: '\\Trash' },
      { path: 'INBOX' },
      { path: '[Gmail]' }, // no STATUS entry → counts omitted
    ];
    fake.statusByPath = {
      INBOX: { messages: 120, unseen: 3 },
      Trash: { messages: 9, unseen: 0 },
    };
    const client = await connectServer(server => registerListFolders(server, managerWith(fake)));
    const result = await client.callTool({ name: 'email_list_folders', arguments: { account: 'personal' } });
    expect(isError(result)).toBe(false);
    expect(textOf(result).split('\n')).toEqual([
      'INBOX — 3 unseen / 120 total',
      'Trash [\\Trash] — 0 unseen / 9 total',
      '[Gmail]',
    ]);
  });

  it('returns isError for an unknown account', async () => {
    const client = await connectServer(server => registerListFolders(server, managerWith(new FakeImap())));
    const result = await client.callTool({ name: 'email_list_folders', arguments: { account: 'nope' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Unknown account/);
  });
});
