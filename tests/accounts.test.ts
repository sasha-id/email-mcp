import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/accounts.js';
import { FakeImap, fakeConfig, managerWith } from './fakes.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountManager', () => {
  it('throws a listing error for unknown accounts', () => {
    const manager = managerWith(new FakeImap());
    expect(() => manager.account('nope')).toThrow(/Unknown account "nope".*personal, work/);
  });

  it('connects lazily and reuses the connection', async () => {
    let made = 0;
    const fake = new FakeImap();
    const manager = new AccountManager(fakeConfig(), {
      makeClient: () => {
        made++;
        return fake as never;
      },
    });
    expect(made).toBe(0);
    await manager.withClient('personal', async () => 1);
    await manager.withClient('personal', async () => 2);
    expect(made).toBe(1);
    expect(fake.callsTo('connect').length).toBe(1);
  });

  it('passes the resolved password and TLS flag into the connection options', async () => {
    const fake = new FakeImap();
    const opts: Array<Record<string, unknown>> = [];
    const config = fakeConfig();
    config.accounts.personal.auth = { type: 'password', pass: 'op://Private/mail/password' };
    const manager = new AccountManager(config, {
      makeClient: o => {
        opts.push(o as never);
        return fake as never;
      },
      opReader: async () => 'resolved-secret',
    });
    await manager.withClient('personal', async () => null);
    expect(opts[0].auth).toEqual({ user: 'me@example.com', pass: 'resolved-secret' });
    expect(opts[0].secure).toBe(true); // port 993 implies TLS
  });

  it('disables happy-eyeballs autoSelectFamily under tls, where ImapFlow reads it', async () => {
    // Dual-stack hosts with high IPv4 RTT lose Node's 250ms happy-eyeballs race on
    // every connection; pin the family choice instead. ImapFlow only forwards
    // `options.tls` to net/tls.connect, so nesting is what makes this take effect —
    // the same flag at the top level is accepted and ignored.
    const fake = new FakeImap();
    const opts: Array<Record<string, unknown>> = [];
    const manager = new AccountManager(fakeConfig(), {
      makeClient: o => {
        opts.push(o as never);
        return fake as never;
      },
    });
    await manager.withClient('personal', async () => null);
    expect(opts[0].tls).toEqual({ autoSelectFamily: false });
    expect(opts[0].autoSelectFamily).toBeUndefined();
  });

  it('retries exactly once on a dropped connection', async () => {
    const dead = new FakeImap();
    const alive = new FakeImap();
    const manager = managerWith([dead, alive]);
    let attempt = 0;
    const result = await manager.withClient('personal', async client => {
      attempt++;
      if (attempt === 1) {
        dead.usable = false;
        throw new Error('Connection not available');
      }
      return client === (alive as never) ? 'recovered' : 'wrong-client';
    });
    expect(result).toBe('recovered');
    expect(attempt).toBe(2); // first attempt threw, retried exactly once
    expect(dead.callsTo('connect').length).toBe(1);
    expect(alive.callsTo('connect').length).toBe(1); // a fresh connection was established for the retry
  });

  it('retries at most once, then propagates a second consecutive drop', async () => {
    const first = new FakeImap();
    const second = new FakeImap();
    const manager = managerWith([first, second]);
    let attempts = 0;
    await expect(
      manager.withClient('personal', async client => {
        attempts++;
        (client as unknown as { usable: boolean }).usable = false;
        throw new Error('dropped again');
      }),
    ).rejects.toThrow('dropped again');
    expect(attempts).toBe(2); // initial attempt + exactly one retry, then propagate
  });

  it('does not retry logical errors on a healthy connection', async () => {
    const fake = new FakeImap();
    const manager = managerWith(fake);
    let attempts = 0;
    await expect(
      manager.withClient('personal', async () => {
        attempts++;
        throw new Error('NO such mailbox');
      }),
    ).rejects.toThrow(/such mailbox/);
    expect(attempts).toBe(1);
  });

  it('with retry disabled, a dropped connection fails after a single attempt', async () => {
    // For non-idempotent operations (APPEND) the caller opts out of the
    // retry-once behaviour entirely.
    const dead = new FakeImap();
    const manager = managerWith([dead, new FakeImap()]);
    let attempts = 0;
    await expect(
      manager.withClient(
        'personal',
        async client => {
          attempts++;
          (client as unknown as { usable: boolean }).usable = false;
          throw new Error('Connection not available');
        },
        { retry: false },
      ),
    ).rejects.toThrow('Connection not available');
    expect(attempts).toBe(1);
    expect(dead.callsTo('connect').length).toBe(1);
  });

  it('withMailbox acquires and always releases the lock', async () => {
    const fake = new FakeImap();
    const manager = managerWith(fake);
    await expect(
      manager.withMailbox('personal', 'INBOX', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fake.lockedPaths).toEqual(['INBOX']);
    expect(fake.releasedPaths).toEqual(['INBOX']);
  });

  it('tears down idle connections after 5 minutes', async () => {
    vi.useFakeTimers();
    const fake = new FakeImap();
    const manager = managerWith(fake);
    await manager.withClient('personal', async () => null);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(fake.callsTo('logout').length).toBe(1);
  });

  it('does not tear down the connection while an operation is in flight', async () => {
    // The idle reaper must measure idleness, not wall time since acquisition: a slow
    // fetch (large message on a throttled link) is activity, not idleness.
    vi.useFakeTimers();
    const fake = new FakeImap();
    const manager = managerWith(fake);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const op = manager.withClient('personal', () => gate);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(fake.callsTo('logout').length).toBe(0); // still running — hands off
    release();
    await op;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(fake.callsTo('logout').length).toBe(1); // idle again: reap normally
  });

  it('tears down an operation hung past the 30-minute cap', async () => {
    // A genuinely wedged operation must not pin the connection (and its mailbox
    // lock) forever — the deferral has a generous absolute ceiling.
    vi.useFakeTimers();
    const fake = new FakeImap();
    const manager = managerWith(fake);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const op = manager.withClient('personal', () => gate);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(fake.callsTo('logout').length).toBe(0); // busy: deferred, not yet at the cap
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(fake.callsTo('logout').length).toBe(1); // 31 minutes hung: hard cap
    release();
    await op;
  });

  it('survives a connection error event and reconnects on next use', async () => {
    // ImapFlow's emitError() ends in emit('error'); with no listener that
    // throws and kills the whole MCP process. The manager must absorb it and
    // evict the client so the next call connects fresh.
    const dead = new FakeImap();
    const alive = new FakeImap();
    const manager = managerWith([dead, alive]);
    await manager.withClient('personal', async () => 1);
    dead.emit('error', new Error('Socket timeout')); // throws if unhandled
    const result = await manager.withClient('personal', async () => 2);
    expect(result).toBe(2);
    expect(dead.callsTo('connect').length).toBe(1);
    expect(alive.callsTo('connect').length).toBe(1); // evicted → fresh connection
  });

  it('shares one in-flight connection across concurrent calls', async () => {
    let made = 0;
    const fake = new FakeImap();
    const manager = new AccountManager(fakeConfig(), {
      makeClient: () => {
        made++;
        return fake as never;
      },
    });
    await Promise.all([
      manager.withClient('personal', async () => 1),
      manager.withClient('personal', async () => 2),
    ]);
    expect(made).toBe(1);
  });

  it('enriches mailbox-open failures with the available folders', async () => {
    const fake = new FakeImap();
    fake.lockError = new Error('NO [NONEXISTENT] Unknown Mailbox');
    fake.folders = [{ path: 'INBOX' }, { path: 'Archive' }];
    const manager = managerWith(fake);
    await expect(manager.withMailbox('personal', 'Archiv', async () => null)).rejects.toThrow(
      /Cannot open mailbox "Archiv" in account "personal"\. Available folders: INBOX, Archive/,
    );
  });
});
