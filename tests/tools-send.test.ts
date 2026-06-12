import { describe, expect, it } from 'vitest';
import { AccountManager } from '../src/accounts.js';
import type { SmtpTransportOptions } from '../src/tools/send.js';
import { registerSend } from '../src/tools/send.js';
import { FakeImap, asImap, fakeConfig, managerWith } from './fakes.js';
import { EML_REPLY_TARGET } from './fixtures.js';
import { connectServer, isError, textOf } from './mcp.js';

type Sent = { transport: SmtpTransportOptions; envelope: { from: string; to: string[] }; raw: Buffer };

function captureSend() {
  const sent: Sent[] = [];
  const sendRaw = async (transport: SmtpTransportOptions, envelope: { from: string; to: string[] }, raw: Buffer) => {
    sent.push({ transport, envelope, raw });
  };
  return { sent, sendRaw };
}

describe('email_send', () => {
  it('sends a plain message and appends to the Sent folder when configured', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    const { sent, sendRaw } = captureSend();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));
    const result = await client.callTool({
      name: 'email_send',
      arguments: {
        account: 'personal',
        to: ['bob@example.com'],
        cc: ['carol@example.com'],
        subject: 'Hello',
        text: 'Hi Bob',
      },
    });
    expect(isError(result)).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0].transport).toEqual({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      auth: { user: 'me@example.com', pass: 'hunter2' },
    });
    expect(sent[0].envelope).toEqual({ from: 'me@example.com', to: ['bob@example.com', 'carol@example.com'] });
    const raw = sent[0].raw.toString();
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('Hi Bob');
    // personal has appendToSent: true → message saved to the \Sent folder
    expect(fake.callsTo('append')[0].args[0]).toBe('Sent');
    expect(textOf(result)).toContain('saved to Sent');
  });

  it('replies in-thread: References/In-Reply-To set, recipient and subject defaulted', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.fetchOneResult = { uid: 9, source: Buffer.from(EML_REPLY_TARGET) };
    const { sent, sendRaw } = captureSend();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));
    const result = await client.callTool({
      name: 'email_send',
      arguments: { account: 'personal', text: 'Monday works.', replyTo: { uid: 9 } },
    });
    expect(isError(result)).toBe(false);
    const raw = sent[0].raw.toString();
    expect(raw).toContain('In-Reply-To: <kickoff-9@example.com>');
    expect(raw).toContain('References: <thread-root-1@example.com> <kickoff-9@example.com>');
    expect(raw).toContain('Subject: Re: Project kickoff');
    expect(sent[0].envelope.to).toEqual(['dana-replies@example.com']); // Reply-To wins over From
  });

  it('fails without recipients or without smtp config', async () => {
    const { sendRaw } = captureSend();
    const fake = new FakeImap();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));

    const noRecipients = await client.callTool({
      name: 'email_send',
      arguments: { account: 'personal', subject: 'X', text: 'Y' },
    });
    expect(isError(noRecipients)).toBe(true);
    expect(textOf(noRecipients)).toMatch(/recipients/i);

    const config = fakeConfig();
    delete config.accounts.personal.smtp;
    const noSmtp = new AccountManager(config, { makeClient: () => asImap(fake) });
    const client2 = await connectServer(server => registerSend(server, noSmtp, { sendRaw }));
    const result = await client2.callTool({
      name: 'email_send',
      arguments: { account: 'personal', to: ['x@y.z'], subject: 'X', text: 'Y' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/no smtp configuration/);
  });
});
