#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AccountManager } from './accounts.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new AccountManager(config);
  const server = createServer(manager);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP transport — all logging goes to stderr
  console.error(`email-mcp ready — accounts: ${manager.accountNames().join(', ')}`);
  const shutdown = async () => {
    await manager.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`email-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
