import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Builds a server via `build`, connects an in-memory client, returns the client. */
export async function connectServer(build: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'test-email-mcp', version: '0.0.0' });
  build(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Concatenates the text content blocks of a CallToolResult. */
export function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map(c => c.text ?? '').join('\n');
}

export function isError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError);
}
