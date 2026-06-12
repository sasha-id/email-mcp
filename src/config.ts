import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
