import { describe, expect, it } from 'vitest';
import { AccountManager } from '../src/accounts.js';
import type { SmtpTransportOptions } from '../src/tools/send.js';
import { registerSend } from '../src/tools/send.js';
import { FakeImap, asImap, fakeConfig, managerWith } from './fakes.js';
import { EML_REPLY_TARGET_HEADERS } from './fixtures.js';
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
    fake.metaResult = { uid: 9, headers: Buffer.from(EML_REPLY_TARGET_HEADERS) };
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
    // Threading needs only a handful of headers — never the full source, which
    // can be tens of MB of attachments on a reply target.
    const [, query] = fake.callsTo('fetchOne')[0].args as [unknown, Record<string, unknown>, unknown];
    expect(query).not.toHaveProperty('source');
    expect(query.headers).toEqual(
      expect.arrayContaining(['message-id', 'references', 'subject', 'from', 'reply-to']),
    );
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

  it('keeps bcc out of the message headers but in the delivery envelope', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    const { sent, sendRaw } = captureSend();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));
    const result = await client.callTool({
      name: 'email_send',
      arguments: {
        account: 'personal',
        to: ['bob@example.com'],
        bcc: ['secret-bcc@example.com'],
        subject: 'Hello',
        text: 'Hi',
      },
    });
    expect(isError(result)).toBe(false);
    const raw = sent[0].raw.toString();
    expect(raw).not.toMatch(/^Bcc:/im); // no Bcc header leaked to recipients
    expect(raw).not.toContain('secret-bcc@example.com');
    expect(sent[0].envelope.to).toContain('secret-bcc@example.com'); // but still delivered via envelope
  });

  it('reports a successful send even if saving to Sent fails', async () => {
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.append = async () => {
      throw new Error('mailbox is over quota');
    };
    const { sent, sendRaw } = captureSend();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));
    const result = await client.callTool({
      name: 'email_send',
      arguments: { account: 'personal', to: ['bob@example.com'], subject: 'Hi', text: 'Body' },
    });
    expect(isError(result)).toBe(false); // the send succeeded
    expect(sent.length).toBe(1);
    expect(textOf(result)).toMatch(/saving to Sent failed/);
    expect(textOf(result)).toContain('over quota');
  });

  it('does not retry APPEND on a dropped connection — a retry could file a duplicate', async () => {
    // APPEND is not idempotent: if the connection died after the server
    // accepted the copy, re-appending on a fresh client would put two copies
    // in Sent. One attempt, then report the failure.
    const fake = new FakeImap();
    fake.folders = [{ path: 'Sent', specialUse: '\\Sent' }];
    fake.appendHook = () => {
      fake.usable = false; // connection died around the append
    };
    fake.appendError = new Error('Connection not available');
    const { sent, sendRaw } = captureSend();
    const client = await connectServer(server => registerSend(server, managerWith(fake), { sendRaw }));
    const result = await client.callTool({
      name: 'email_send',
      arguments: { account: 'personal', to: ['bob@example.com'], subject: 'Hi', text: 'Body' },
    });
    expect(isError(result)).toBe(false);
    expect(sent.length).toBe(1);
    expect(textOf(result)).toMatch(/saving to Sent failed/);
    expect(fake.callsTo('append').length).toBe(1); // no silent retry
    expect(fake.callsTo('connect').length).toBe(1); // and no reconnect for it
  });
});
