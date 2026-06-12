import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/search.js';

describe('buildSearchQuery', () => {
  it('maps all params to ImapFlow search keys', () => {
    expect(
      buildSearchQuery({
        text: 'invoice',
        from: 'alice@example.com',
        to: 'bob@example.com',
        subject: 'Q2',
        since: '2026-06-01',
        before: '2026-06-10',
        seen: false,
        flagged: true,
      }),
    ).toEqual({
      body: 'invoice',
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'Q2',
      since: new Date('2026-06-01T00:00:00Z'),
      before: new Date('2026-06-10T00:00:00Z'),
      seen: false,
      flagged: true,
    });
  });

  it('preserves seen: false (unread-only) instead of dropping falsy values', () => {
    expect(buildSearchQuery({ seen: false })).toEqual({ seen: false });
  });

  it('returns { all: true } for empty params', () => {
    expect(buildSearchQuery({})).toEqual({ all: true });
  });

  it('rejects malformed dates', () => {
    expect(() => buildSearchQuery({ since: '01/06/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => buildSearchQuery({ before: '2026-13-45' })).toThrow(/Invalid before date/);
  });
});
