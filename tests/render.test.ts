import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { formatAddress, htmlToText, renderEmail, summarizeMessage } from '../src/render.js';
import { EML_HTML_ONLY, EML_PLAIN, EML_WITH_ATTACHMENT } from './fixtures.js';

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

describe('renderEmail', () => {
  it('renders headers and plain-text body', async () => {
    const email = await PostalMime.parse(EML_PLAIN);
    const text = renderEmail(email);
    expect(text).toContain('From: Alice Example <alice@example.com>');
    expect(text).toContain('Cc: carol@example.com');
    expect(text).toContain('Subject: Lunch?');
    expect(text).toContain('Message-ID: <plain-1@example.com>');
    expect(text).toContain('Sushi at noon?');
  });

  it('falls back to stripped HTML when there is no text part', async () => {
    const email = await PostalMime.parse(EML_HTML_ONLY);
    const text = renderEmail(email);
    expect(text).toContain('First & second item');
    expect(text).not.toContain('<p>');
  });

  it('lists attachment metadata without inlining content', async () => {
    const email = await PostalMime.parse(EML_WITH_ATTACHMENT);
    const text = renderEmail(email);
    expect(text).toContain('Attachments:');
    expect(text).toMatch(/\[0\] report\.pdf — application\/pdf, \d+ bytes/);
    expect(text).not.toContain('JVBERi0');
  });

  it('truncates long bodies with a notice', async () => {
    const email = await PostalMime.parse(EML_PLAIN);
    const text = renderEmail(email, { maxBody: 5 });
    expect(text).toContain('Sushi'.slice(0, 5));
    expect(text).toContain('[body truncated at 5 characters]');
  });
});
