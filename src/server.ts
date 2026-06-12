import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from './accounts.js';
import { registerListAccounts } from './tools/accounts.js';
import { registerAuthenticate } from './tools/authenticate.js';
import { registerDelete } from './tools/delete.js';
import { registerListFolders } from './tools/folders.js';
import { registerMark } from './tools/mark.js';
import { registerMove } from './tools/move.js';
import { registerRead } from './tools/read.js';
import { registerSearch } from './tools/search.js';
import { registerSend, type SendDeps } from './tools/send.js';

export interface ServerDeps {
  send?: SendDeps;
}

export function createServer(manager: AccountManager, deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'email-mcp', version: '0.1.0' });
  registerListAccounts(server, manager);
  registerListFolders(server, manager);
  registerSearch(server, manager);
  registerRead(server, manager);
  registerMark(server, manager);
  registerMove(server, manager);
  registerDelete(server, manager);
  registerSend(server, manager, deps.send);
  registerAuthenticate(server, manager);
  return server;
}
