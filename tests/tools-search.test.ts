import { describe, expect, it } from 'vitest';
import { registerSearch } from '../src/tools/search.js';
import { FakeImap, managerWith } from './fakes.js';
import { connectServer, isError, textOf } from './mcp.js';

function fakeWithMessages(): FakeImap {
  const fake = new FakeImap();
  fake.searchResults = [11, 52, 37];
  fake.fetchResults = [
    {
      uid: 37,
      envelope: { date: new Date('2026-06-02T08:00:00Z'), subject: 'Mid', from: [{ address: 'b@x.y' }] },
      flags: new Set<string>(),
      size: 200,
    },
    {
      uid: 52,
      envelope: { date: new Date('2026-06-03T08:00:00Z'), subject: 'New', from: [{ address: 'c@x.y' }] },
      flags: new Set(['\\Seen']),
      size: 300,
    },
    {
      uid: 11,
      envelope: { date: new Date('2026-06-01T08:00:00Z'), subject: 'Old', from: [{ address: 'a@x.y' }] },
      flags: new Set<string>(),
      size: 100,
    },
  ];
  return fake;
}

describe('email_search', () => {
  it('searches the mailbox and returns newest-first summaries', async () => {
    const fake = fakeWithMessages();
    const client = await connectServer(server => registerSearch(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_search',
      arguments: { account: 'personal', from: 'x.y', seen: false },
    });
    expect(isError(result)).toBe(false);
    const lines = textOf(result).split('\n');
    expect(lines[0]).toBe('3 match(es) in personal/INBOX, showing 3 (newest first):');
    expect(lines[1]).toMatch(/^uid=52 /);
    expect(lines[2]).toMatch(/^uid=37 /);
    expect(lines[3]).toMatch(/^uid=11 /);
    // the mailbox was locked and the search query mapped
    expect(fake.lockedPaths).toEqual(['INBOX']);
    const [query] = fake.callsTo('search')[0].args as [Record<string, unknown>];
    expect(query).toEqual({ from: 'x.y', seen: false });
  });

  it('applies the limit to newest uids', async () => {
    const fake = fakeWithMessages();
    const client = await connectServer(server => registerSearch(server, managerWith(fake)));
    await client.callTool({
      name: 'email_search',
      arguments: { account: 'personal', limit: 2 },
    });
    const [range] = fake.callsTo('fetch')[0].args as [number[]];
    expect(range).toEqual([52, 37]);
  });

  it('reports zero matches without fetching', async () => {
    const fake = new FakeImap();
    fake.searchResults = [];
    const client = await connectServer(server => registerSearch(server, managerWith(fake)));
    const result = await client.callTool({ name: 'email_search', arguments: { account: 'personal' } });
    expect(textOf(result)).toBe('No matches in personal/INBOX.');
    expect(fake.callsTo('fetch').length).toBe(0);
  });

  it('surfaces date validation errors as isError', async () => {
    const client = await connectServer(server => registerSearch(server, managerWith(new FakeImap())));
    const result = await client.callTool({
      name: 'email_search',
      arguments: { account: 'personal', since: 'June 1' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/YYYY-MM-DD/);
  });

  it('surfaces a failed SEARCH as an error, not "No matches"', async () => {
    const fake = new FakeImap();
    fake.search = async () => false as unknown as number[];
    const client = await connectServer(server => registerSearch(server, managerWith(fake)));
    const result = await client.callTool({ name: 'email_search', arguments: { account: 'personal' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Search failed/);
  });
});
