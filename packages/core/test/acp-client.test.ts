/**
 * AcpClient against a real (fixture) agent process speaking ACP over
 * stdio: proves the prompt loop classifies agent_thought_chunk updates
 * into onThought and agent_message_chunk text into onChunk.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'thought-agent.mjs');

describe('AcpClient prompt loop (fixture agent over stdio)', () => {
  it('streams thought chunks to onThought and text chunks to onChunk', async () => {
    const client = new AcpClient({
      appName: 'acp-client-test',
      writerName: 'Test',
      command: process.execPath,
      args: [fixture],
      env: {},
    });
    await client.start();
    try {
      await client.createSession('test-session');
      const thoughts: string[] = [];
      const chunks: string[] = [];
      const reply = await client.prompt('test-session', [{ type: 'text', text: 'hi' }], {
        onChunk: (c) => chunks.push(c),
        onThought: (c) => thoughts.push(c),
        timeoutMs: 20_000,
      });
      expect(thoughts).toEqual(['Reading the prompt. ', 'Deciding on the reply.']);
      expect(chunks).toEqual(['Here is ', 'the reply.']);
      expect(reply).toBe('Here is the reply.');
    } finally {
      client.stop();
    }
  });

  it('forwards usage_update snapshots to onUsage', async () => {
    const client = new AcpClient({
      appName: 'acp-client-test',
      writerName: 'Test',
      command: process.execPath,
      args: [fixture],
      env: {},
    });
    await client.start();
    try {
      await client.createSession('test-session');
      const usages = [];
      await client.prompt('test-session', [{ type: 'text', text: 'hi' }], {
        onUsage: (u) => usages.push(u),
        timeoutMs: 20_000,
      });
      expect(usages).toEqual([{ used: 12345, size: 200000, cost: { amount: 0.0123, currency: 'USD' } }]);
    } finally {
      client.stop();
    }
  });
});
