import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerRead } from '../src/tools/read.js';
import { FakeImap, managerWith } from './fakes.js';
import { EML_WITH_ATTACHMENT_HEADERS, PDF_BYTES, STRUCT_WITH_ATTACHMENT } from './fixtures.js';
import { connectServer, isError, textOf } from './mcp.js';

function fakeWithMeta(): FakeImap {
  const fake = new FakeImap();
  fake.metaResult = { uid: 7, headers: Buffer.from(EML_WITH_ATTACHMENT_HEADERS), bodyStructure: STRUCT_WITH_ATTACHMENT };
  fake.downloads.set('1', Buffer.from('Report attached.'));
  fake.downloads.set('2', PDF_BYTES);
  return fake;
}

describe('email_read', () => {
  it('renders headers, body, and attachment metadata from structure + partial fetches only', async () => {
    const fake = fakeWithMeta();
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

    // The whole point: never pull the full source. One headers+structure fetch
    // (a few KB), then a bounded download of just the text part.
    const [, query] = fake.callsTo('fetchOne')[0].args as [unknown, Record<string, unknown>, unknown];
    expect(query).not.toHaveProperty('source');
    expect(query.bodyStructure).toBe(true);
    expect(query.headers).toBe(true);
    const [range, part, opts] = fake.callsTo('download')[0].args as [string, string, { uid: boolean; maxBytes: number }];
    expect(range).toBe('7');
    expect(part).toBe('1'); // the text part, not the PDF
    expect(opts.uid).toBe(true);
    expect(opts.maxBytes).toBeGreaterThan(0);
  });

  it('strips the html body when the message has no plain part', async () => {
    const fake = new FakeImap();
    fake.metaResult = {
      uid: 3,
      headers: Buffer.from('From: news@example.com\r\nSubject: Digest\r\n\r\n'),
      bodyStructure: { type: 'text/html', size: 120 },
    };
    fake.downloads.set('1', Buffer.from('<p>First &amp; second item</p>'));
    const client = await connectServer(server => registerRead(server, managerWith(fake)));
    const result = await client.callTool({ name: 'email_read', arguments: { account: 'personal', uid: 3 } });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toContain('First & second item');
    expect(textOf(result)).not.toContain('<p>');
  });

  it('returns isError when the uid does not exist', async () => {
    const fake = new FakeImap(); // metaResult stays false
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
  it('streams the decoded attachment to an absolute path', async () => {
    const fake = fakeWithMeta();
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
    expect(readFileSync(savePath)).toEqual(PDF_BYTES);
    // Only the requested part was transferred — not the whole message.
    const [, part] = fake.callsTo('download')[0].args as [unknown, string, unknown];
    expect(part).toBe('2');
    expect(fake.callsTo('fetchOne')[0].args[1]).not.toHaveProperty('source');
  });

  it('finds attachments by filename as well as by index', async () => {
    const fake = fakeWithMeta();
    const dir = mkdtempSync(join(tmpdir(), 'email-mcp-att-'));
    const savePath = join(dir, 'byname.pdf');
    const client = await connectServer(server => registerRead(server, managerWith(fake)));
    const result = await client.callTool({
      name: 'email_attachment',
      arguments: { account: 'personal', uid: 7, filename: 'report.pdf', savePath },
    });
    expect(isError(result)).toBe(false);
    expect(readFileSync(savePath)).toEqual(PDF_BYTES);
  });

  it('rejects relative savePath and unknown attachments helpfully', async () => {
    const fake = fakeWithMeta();
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
