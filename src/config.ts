import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const HostPortSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean().optional(),
});

const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('password'), pass: z.string().min(1) }),
  z.object({
    type: z.literal('m365-oauth'),
    tenant: z.string().min(1),
    clientId: z.string().min(1).optional(),
  }),
]);

const AccountSchema = z.object({
  user: z.string().min(1),
  imap: HostPortSchema,
  smtp: HostPortSchema.optional(),
  auth: AuthSchema,
  appendToSent: z.boolean().default(false),
});

const ConfigSchema = z.object({
  accounts: z.record(z.string(), AccountSchema),
});

export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return process.env.EMAIL_MCP_CONFIG ?? join(homedir(), '.config', 'email-mcp', 'accounts.json');
}

export function loadConfig(path: string = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Cannot read config file at ${path}. Set EMAIL_MCP_CONFIG or create the file (see accounts.example.json).`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Config file at ${path} is not valid JSON.`);
  }
  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid config at ${path}: ${issues}`);
  }
  return result.data;
}

// --- secret resolution ---

const execFileAsync = promisify(execFile);

export type OpReader = (ref: string) => Promise<string>;

const opRead: OpReader = async ref => {
  const { stdout } = await execFileAsync('op', ['read', ref]);
  return stdout.replace(/\r?\n$/, '');
};

const secretCache = new Map<string, string>();

export function clearSecretCache(): void {
  secretCache.clear();
}

export async function resolvePassword(pass: string, reader: OpReader = opRead): Promise<string> {
  if (!pass.startsWith('op://')) return pass;
  const cached = secretCache.get(pass);
  if (cached !== undefined) return cached;
  let value: string;
  try {
    value = await reader(pass);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(
      `Failed to resolve 1Password reference ${pass} — is the op CLI installed and signed in? (${detail})`,
    );
  }
  secretCache.set(pass, value);
  return value;
}
