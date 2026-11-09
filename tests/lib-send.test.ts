import { describe, expect, it } from 'vitest';
import { AccountManager, sendMail } from '../src/lib.js';
import { FakeImap, fakeConfig, managerWith } from './fakes.js';

function capture() {
  const sent: Array<{ transport: unknown; envelope: { from: string; to: string[] }; raw: string }> = [];
  const sendRaw = async (transport: unknown, envelope: { from: string; to: string[] }, raw: Buffer) => {
    sent.push({ transport, envelope, raw: raw.toString() });
  };
  return { sent, sendRaw };
}

const base = { to: ['a@example.com'], subject: 'Hi', text: 'Body' };

describe('sendMail headers', () => {
  it('uses the given Message-ID and sets threading headers', async () => {
    const { sent, sendRaw } = capture();
    await sendMail(
      managerWith(new FakeImap()),
      'personal',
      { ...base, messageId: '<nyx.1@example.com>', inReplyTo: '<orig@x.com>', references: '<r1@x.com> <orig@x.com>', replyTo: 'r@example.com' },
      { sendRaw },
    );
    expect(sent[0].raw).toMatch(/^Message-ID: <nyx\.1@example\.com>\r?$/m);
    expect(sent[0].raw).toMatch(/^In-Reply-To: <orig@x\.com>\r?$/m);
    expect(sent[0].raw).toMatch(/^References: <r1@x\.com> <orig@x\.com>\r?$/m);
    expect(sent[0].raw).toMatch(/^Reply-To: r@example\.com\r?$/m);
  });
});

describe('sendMail Sent copy', () => {
  it('appends to \\Sent by default for accounts with appendToSent', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    const { sent, sendRaw } = capture();
    const res = await sendMail(managerWith(fake), 'personal', base, { sendRaw });
    expect(res).toMatchObject({ sentAppended: true, sentPath: 'Sent' });
    const call = fake.callsTo('append')[0];
    expect(call.args[0]).toBe('Sent');
    expect((call.args[1] as Buffer).toString()).toBe(sent[0].raw);
    expect(call.args[2]).toEqual(['\\Seen']);
  });

  it('does not append when appendToSent is false, even if the account says true', async () => {
    const fake = new FakeImap();
    const { sendRaw } = capture();
    const res = await sendMail(managerWith(fake), 'personal', { ...base, appendToSent: false }, { sendRaw });
    expect(res.sentAppended).toBe(false);
    expect(fake.callsTo('append')).toHaveLength(0);
  });

  it('appends when asked, even if the account default is off', async () => {
    const config = fakeConfig();
    config.accounts.personal.appendToSent = false;
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    const manager = new AccountManager(config, { makeClient: () => fake as never });
    const { sendRaw } = capture();
    expect((await sendMail(manager, 'personal', base, { sendRaw })).sentAppended).toBe(false);
    expect((await sendMail(manager, 'personal', { ...base, appendToSent: true }, { sendRaw })).sentAppended).toBe(true);
    expect(fake.callsTo('append')).toHaveLength(1);
  });

  it('reports a failed append in the result instead of throwing', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.appendError = new Error('mailbox is over quota');
    const { sent, sendRaw } = capture();
    const res = await sendMail(managerWith(fake), 'personal', base, { sendRaw });
    expect(sent).toHaveLength(1);
    expect(res.sentAppended).toBe(false);
    expect(res.sentAppendError).toMatch(/over quota/);
  });

  it('reports a missing \\Sent folder in the result', async () => {
    const { sendRaw } = capture();
    const res = await sendMail(managerWith(new FakeImap()), 'personal', base, { sendRaw });
    expect(res.sentAppended).toBe(false);
    expect(res.sentAppendError).toMatch(/no .*Sent folder/);
  });
});

describe('sendMail validation', () => {
  it('rejects an account with no smtp config', async () => {
    const config = fakeConfig();
    delete config.accounts.personal.smtp;
    const manager = new AccountManager(config, { makeClient: () => new FakeImap() as never });
    const { sent, sendRaw } = capture();
    await expect(sendMail(manager, 'personal', base, { sendRaw })).rejects.toThrow(/no smtp configuration/);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['to', { to: ['a@b.com\r\nBcc: evil@x.com'] }],
    ['cc', { cc: ['a@b.com\nx'] }],
    ['bcc', { bcc: ['a@b.com\rx'] }],
    ['replyTo', { replyTo: 'a@b.com\r\nX: y' }],
  ])('rejects CR/LF in %s before sending', async (label, patch) => {
    const { sent, sendRaw } = capture();
    await expect(sendMail(managerWith(new FakeImap()), 'personal', { ...base, ...patch }, { sendRaw })).rejects.toThrow(
      new RegExp(`${label}.*CR or LF`),
    );
    expect(sent).toHaveLength(0);
  });

  it('rejects CR/LF in the account address', async () => {
    const config = fakeConfig();
    config.accounts.personal.user = 'me@example.com\r\nBcc: x@y.com';
    const manager = new AccountManager(config, { makeClient: () => new FakeImap() as never });
    const { sendRaw } = capture();
    await expect(sendMail(manager, 'personal', base, { sendRaw })).rejects.toThrow(/from.*CR or LF/);
  });
});

describe('dedicated IMAP connection', () => {
  it('builds connect options with fresh auth for the account', async () => {
    const manager = managerWith(new FakeImap());
    expect(await manager.imapConnectOptions('personal')).toEqual({
      host: 'mail.example.com',
      port: 993,
      secure: true,
      auth: { user: 'me@example.com', pass: 'hunter2' },
      logger: false,
      tls: { autoSelectFamily: false },
    });
  });

  it('connectDedicated returns an unpooled, connected client with an error listener', async () => {
    const fakes = [new FakeImap(), new FakeImap()];
    let i = 0;
    const manager = new AccountManager(fakeConfig(), { makeClient: () => fakes[i++] as never });
    const a = (await manager.connectDedicated('personal')) as unknown as FakeImap;
    const b = (await manager.connectDedicated('personal')) as unknown as FakeImap;
    expect(a).not.toBe(b);
    expect(a.connected && b.connected).toBe(true);
    expect(() => a.emit('error', new Error('boom'))).not.toThrow();
    // not pooled: closeAll() leaves dedicated connections alone
    await manager.closeAll();
    expect(a.connected).toBe(true);
  });
});
