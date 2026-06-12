import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'email-mcp-test-'));
  const path = join(dir, 'accounts.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const validConfig = {
  accounts: {
    personal: {
      user: 'me@example.com',
      imap: { host: 'mail.example.com', port: 993 },
      smtp: { host: 'mail.example.com', port: 465 },
      auth: { type: 'password', pass: 'hunter2' },
      appendToSent: true,
    },
    work: {
      user: 'me@corp.example',
      imap: { host: 'outlook.office365.com', port: 993 },
      smtp: { host: 'smtp.office365.com', port: 587 },
      auth: { type: 'm365-oauth', tenant: 'corp.example' },
    },
  },
};

describe('loadConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const config = loadConfig(writeConfig(validConfig));
    expect(Object.keys(config.accounts)).toEqual(['personal', 'work']);
    expect(config.accounts.personal.appendToSent).toBe(true);
    expect(config.accounts.work.appendToSent).toBe(false); // default
    expect(config.accounts.work.auth.type).toBe('m365-oauth');
  });

  it('rejects a config with a malformed account', () => {
    const bad = { accounts: { broken: { user: 'x@y.z', auth: { type: 'password', pass: 'p' } } } };
    expect(() => loadConfig(writeConfig(bad))).toThrow(/Invalid config/);
  });

  it('throws a readable error for a missing file', () => {
    expect(() => loadConfig('/nonexistent/accounts.json')).toThrow(/Cannot read config file/);
  });

  it('throws a readable error for invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'email-mcp-test-'));
    const path = join(dir, 'accounts.json');
    writeFileSync(path, '{not json');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
  });
});
