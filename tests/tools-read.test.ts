import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerRead } from '../src/tools/read.js';
import { FakeImap, managerWith } from './fakes.js';
import { EML_WITH_ATTACHMENT } from './fixtures.js';
import { connectServer, isError, textOf } from './mcp.js';

function fakeWithSource(): FakeImap {
  const fake = new FakeImap();
  fake.fetchOneResult = { uid: 7, source: Buffer.from(EML_WITH_ATTACHMENT) };
  return fake;
}

describe('email_read', () => {
  it('fetches by uid, parses, and renders headers/body/attachment metadata', async () => {
    const fake = fakeWithSource();
    const client = await connectServer(server => registerRead(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_read',
      arguments: { account: 'personal', uid: 7 },
    });
    expect(isError(result)).toBe(false);
    const text = textOf(result);
    expect(text).toContain('Subject: Quarterly report');
    expect(text).toContain('Report attached.');
    expect(text).toMatch(/\[0\] report\.pdf — application\/pdf/);
    const [range, , opts] = fake.callsTo('fetchOne')[0].args as [string, unknown, { uid: boolean }];
    expect(range).toBe('7');
    expect(opts).toEqual({ uid: true });
  });

  it('returns isError when the uid does not exist', async () => {
    const fake = new FakeImap(); // fetchOneResult stays false
    const client = await connectServer(server => registerRead(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_read',
      arguments: { account: 'personal', uid: 999 },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/uid 999 not found in personal\/INBOX/);
  });
});

describe('email_attachment', () => {
  it('writes the decoded attachment to an absolute path', async () => {
    const fake = fakeWithSource();
    const dir = mkdtempSync(join(tmpdir(), 'email-mcp-att-'));
    const savePath = join(dir, 'report.pdf');
    const client = await connectServer(server => registerRead(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_attachment',
      arguments: { account: 'personal', uid: 7, index: 0, savePath },
    });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain(savePath);
    expect(existsSync(savePath)).toBe(true);
    expect(readFileSync(savePath).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects relative savePath and unknown attachments helpfully', async () => {
    const fake = fakeWithSource();
    const client = await connectServer(server => registerRead(server, managerWith(fake)));

    const relative = await client.callTool({
      name: 'email_attachment',
      arguments: { account: 'personal', uid: 7, index: 0, savePath: 'out.pdf' },
    });
    expect(isError(relative)).toBe(true);
    expect(textOf(relative)).toMatch(/absolute/);

    const missing = await client.callTool({
      name: 'email_attachment',
      arguments: { account: 'personal', uid: 7, filename: 'nope.txt', savePath: '/tmp/nope.txt' },
    });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain('[0] report.pdf');
  });
});
