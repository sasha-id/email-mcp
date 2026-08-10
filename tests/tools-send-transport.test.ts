import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));

import { defaultSendRaw } from '../src/tools/send.js';

describe('defaultSendRaw', () => {
  it('disables happy-eyeballs autoSelectFamily and requires TLS on plain connections', async () => {
    const sent: unknown[] = [];
    mocks.createTransport.mockReturnValue({
      sendMail: async (mail: unknown) => {
        sent.push(mail);
      },
      close: () => {},
    });
    await defaultSendRaw(
      { host: 'smtp.example.com', port: 587, secure: false, auth: { user: 'u@x', pass: 'p' } },
      { from: 'u@x', to: ['v@y'] },
      Buffer.from('raw message'),
    );
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        autoSelectFamily: false,
        requireTLS: true,
      }),
    );
    expect(sent.length).toBe(1);
  });

  it('does not require STARTTLS on an implicit-TLS connection', async () => {
    mocks.createTransport.mockReturnValue({ sendMail: async () => {}, close: () => {} });
    await defaultSendRaw(
      { host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'u@x', pass: 'p' } },
      { from: 'u@x', to: ['v@y'] },
      Buffer.from('raw message'),
    );
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, autoSelectFamily: false, requireTLS: false }),
    );
  });
});
