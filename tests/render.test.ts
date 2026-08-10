import { describe, expect, it } from 'vitest';
import { formatAddress, htmlToText, renderMessage, summarizeMessage } from '../src/render.js';

describe('htmlToText', () => {
  it('strips tags, styles, and decodes entities', () => {
    const text = htmlToText(
      '<html><style>p{color:red}</style><body><h1>Hi</h1><p>First &amp; second</p><br>Done</body></html>',
    );
    expect(text).toContain('Hi');
    expect(text).toContain('First & second');
    expect(text).toContain('Done');
    expect(text).not.toContain('<');
    expect(text).not.toContain('color:red');
  });
});

describe('formatAddress', () => {
  it('formats name + address, address-only, and missing', () => {
    expect(formatAddress({ name: 'Alice', address: 'a@x.y' })).toBe('Alice <a@x.y>');
    expect(formatAddress({ address: 'a@x.y' })).toBe('a@x.y');
    expect(formatAddress(undefined)).toBe('(unknown)');
  });
});

describe('summarizeMessage', () => {
  it('renders a one-line summary with uid, date, from, subject, flags, size', () => {
    const line = summarizeMessage({
      uid: 42,
      envelope: {
        date: new Date('2026-06-01T10:00:00Z'),
        subject: 'Lunch?',
        from: [{ name: 'Alice Example', address: 'alice@example.com' }],
      },
      flags: new Set(['\\Seen']),
      size: 1234,
    });
    expect(line).toBe('uid=42 2026-06-01 Alice Example <alice@example.com> — Lunch? [\\Seen] (1234 bytes)');
  });
});

describe('renderMessage', () => {
  it('renders headers and body', () => {
    const text = renderMessage({
      from: { name: 'Alice Example', address: 'alice@example.com' },
      to: [{ address: 'bob@example.com' }],
      cc: [{ address: 'carol@example.com' }],
      date: 'Mon, 01 Jun 2026 10:00:00 +0000',
      subject: 'Lunch?',
      messageId: '<plain-1@example.com>',
      body: 'Sushi at noon?',
      attachments: [],
    });
    expect(text).toContain('From: Alice Example <alice@example.com>');
    expect(text).toContain('Cc: carol@example.com');
    expect(text).toContain('Subject: Lunch?');
    expect(text).toContain('Message-ID: <plain-1@example.com>');
    expect(text).toContain('Sushi at noon?');
  });

  it('lists attachment metadata without inlining content', () => {
    const text = renderMessage({
      from: { address: 'alice@example.com' },
      subject: 'Quarterly report',
      body: 'Report attached.',
      attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', size: 512_000 }],
    });
    expect(text).toContain('Attachments:');
    expect(text).toContain('[0] report.pdf — application/pdf, 512000 bytes');
  });

  it('truncates long bodies with a notice', () => {
    const text = renderMessage(
      { from: { address: 'a@x.y' }, subject: 'S', body: 'Sushi at noon?', attachments: [] },
      { maxBody: 5 },
    );
    expect(text).toContain('Sushi');
    expect(text).toContain('[body truncated at 5 characters]');
  });
});
