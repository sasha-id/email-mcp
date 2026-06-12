import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { FakeImap, managerWith } from './fakes.js';

describe('createServer', () => {
  it('registers all ten email tools', async () => {
    const server = createServer(managerWith(new FakeImap()));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual([
      'email_attachment',
      'email_authenticate',
      'email_delete',
      'email_list_accounts',
      'email_list_folders',
      'email_mark',
      'email_move',
      'email_read',
      'email_search',
      'email_send',
    ]);
  });
});
