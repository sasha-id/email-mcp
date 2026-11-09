import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  real: undefined as undefined | ((opts: unknown) => unknown),
}));
vi.mock('nodemailer', async importOriginal => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  mocks.real = (opts: unknown) => actual.default.createTransport(opts as never);
  return { default: { ...actual.default, createTransport: mocks.createTransport } };
});

import * as lib from '../src/lib.js';
import { FakeImap, managerWith } from './fakes.js';

describe('lib entry', () => {
  it('exports config, accounts and sending', () => {
    expect(typeof lib.loadConfig).toBe('function');
    expect(typeof lib.AccountManager).toBe('function');
    expect(typeof lib.sendMail).toBe('function');
  });

  it('sendMail hands the SMTP transport the account settings, envelope and raw message', async () => {
    const smtpSent: Array<{ envelope: { from: string; to: string[] }; raw: Buffer }> = [];
    mocks.createTransport.mockImplementation((opts: Record<string, unknown>) =>
      opts.streamTransport
        ? mocks.real!(opts)
        : {
            sendMail: async (mail: never) => {
              smtpSent.push(mail);
            },
            close: () => {},
          },
    );
    const manager = managerWith(new FakeImap());
    const result = await lib.sendMail(manager, 'personal', {
      to: ['a@example.com'],
      cc: ['c@example.com'],
      bcc: ['b@example.com'],
      subject: 'Hello',
      text: 'Body text',
    });

    const smtpOpts = mocks.createTransport.mock.calls.map(c => c[0]).find(o => !o.streamTransport);
    expect(smtpOpts).toMatchObject({ host: 'mail.example.com', port: 465, secure: true, requireTLS: false, auth: { user: expect.any(String) } });
    expect(smtpSent).toHaveLength(1);
    expect(smtpSent[0].envelope.to).toEqual(['a@example.com', 'c@example.com', 'b@example.com']);
    const raw = smtpSent[0].raw.toString();
    expect(raw).toMatch(/Subject: Hello/);
    expect(raw).toMatch(/Body text/);
    expect(raw).not.toMatch(/(^|[<\s,])b@example\.com/m);
    expect(result.recipients).toEqual(['a@example.com', 'c@example.com', 'b@example.com']);
  });

  it('sendMail rejects without recipients, a subject, or smtp config', async () => {
    const manager = managerWith(new FakeImap());
    await expect(lib.sendMail(manager, 'personal', { to: [], subject: 's', text: 't' })).rejects.toThrow(/recipient/i);
    await expect(lib.sendMail(manager, 'personal', { to: ['a@b'], subject: '', text: 't' })).rejects.toThrow(/subject/i);
  });
});
