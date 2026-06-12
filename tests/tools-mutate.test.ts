import { describe, expect, it } from 'vitest';
import { registerDelete } from '../src/tools/delete.js';
import { registerMark } from '../src/tools/mark.js';
import { registerMove } from '../src/tools/move.js';
import { FakeImap, managerWith } from './fakes.js';
import { connectServer, isError, textOf } from './mcp.js';

describe('email_mark', () => {
  it('adds and removes flags on a uid batch', async () => {
    const fake = new FakeImap();
    const client = await connectServer(server => registerMark(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_mark',
      arguments: { account: 'personal', uids: [1, 2, 3], add: ['\\Seen'], remove: ['\\Flagged'] },
    });
    expect(isError(result)).toBe(false);
    expect(fake.callsTo('messageFlagsAdd')[0].args).toEqual([[1, 2, 3], ['\\Seen'], { uid: true }]);
    expect(fake.callsTo('messageFlagsRemove')[0].args).toEqual([[1, 2, 3], ['\\Flagged'], { uid: true }]);
    expect(textOf(result)).toContain('3 message(s)');
  });

  it('rejects a call with neither add nor remove', async () => {
    const client = await connectServer(server => registerMark(server, managerWith(new FakeImap())));
    const result = await client.callTool({
      name: 'email_mark',
      arguments: { account: 'personal', uids: [1] },
    });
    expect(isError(result)).toBe(true);
  });

  it('reports an error when the flag store fails', async () => {
    const fake = new FakeImap();
    fake.messageFlagsAdd = async () => false;
    const client = await connectServer(server => registerMark(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_mark',
      arguments: { account: 'personal', uids: [1], add: ['\\Seen'] },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Failed to add flags/);
  });
});

describe('email_move', () => {
  it('moves a uid batch to the target mailbox', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Archive' }];
    const client = await connectServer(server => registerMove(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_move',
      arguments: { account: 'personal', uids: [5, 6], target: 'Archive' },
    });
    expect(isError(result)).toBe(false);
    expect(fake.callsTo('messageMove')[0].args).toEqual([[5, 6], 'Archive', { uid: true }]);
    expect(textOf(result)).toBe('Moved 2 message(s) from INBOX to Archive in personal.');
  });

  it('reports an error when the move fails', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Archive' }];
    fake.messageMove = async () => false;
    const client = await connectServer(server => registerMove(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_move',
      arguments: { account: 'personal', uids: [5], target: 'Archive' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Move to "Archive" failed/);
  });

  it('reports an error when the target folder does not exist', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'INBOX' }];
    const client = await connectServer(server => registerMove(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_move',
      arguments: { account: 'personal', uids: [5], target: 'Nope' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/does not exist/);
  });
});

describe('email_delete', () => {
  it('moves to the advertised trash folder by default', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'INBOX' }, { path: 'Deleted', specialUse: '\\Trash' }];
    const client = await connectServer(server => registerDelete(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_delete',
      arguments: { account: 'personal', uids: [9] },
    });
    expect(isError(result)).toBe(false);
    expect(fake.callsTo('messageMove')[0].args).toEqual([[9], 'Deleted', { uid: true }]);
    expect(fake.callsTo('messageDelete').length).toBe(0);
    expect(textOf(result)).toBe('Moved 1 message(s) from personal/INBOX to Deleted.');
  });

  it('expunges with permanent: true', async () => {
    const fake = new FakeImap();
    const client = await connectServer(server => registerDelete(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_delete',
      arguments: { account: 'personal', uids: [9, 10], permanent: true },
    });
    expect(isError(result)).toBe(false);
    expect(fake.callsTo('messageDelete')[0].args).toEqual([[9, 10], { uid: true }]);
    expect(textOf(result)).toBe('Permanently deleted 2 message(s) from personal/INBOX.');
  });

  it('errors usefully when no trash folder is advertised', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'INBOX' }];
    const client = await connectServer(server => registerDelete(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_delete',
      arguments: { account: 'personal', uids: [9] },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/No \\Trash folder/);
  });

  it('refuses trash-move from the trash folder itself', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Deleted', specialUse: '\\Trash' }];
    const client = await connectServer(server => registerDelete(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_delete',
      arguments: { account: 'personal', mailbox: 'Deleted', uids: [9] },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/permanent: true/);
  });

  it('reports an error when a permanent delete fails', async () => {
    const fake = new FakeImap();
    fake.messageDelete = async () => false;
    const client = await connectServer(server => registerDelete(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_delete',
      arguments: { account: 'personal', uids: [9], permanent: true },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Permanent delete failed/);
  });
});
