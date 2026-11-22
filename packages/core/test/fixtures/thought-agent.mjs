// Fixture ACP agent for acp-client.test.ts: on session/prompt it streams
// two agent_thought_chunk updates, then two agent_message_chunk updates,
// and ends the turn. Spawned as a real child process by AcpClient.
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';

const app = agent({ name: 'thought-agent-fixture' });

app.onRequest('session/new', () => ({ sessionId: 'fixture-session' }));

app.onRequest('session/prompt', async (ctx) => {
  const { sessionId } = ctx.params;
  const send = (update) => ctx.client.notify('session/update', { sessionId, update });
  await send({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Reading the prompt. ' },
  });
  await send({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Deciding on the reply.' },
  });
  await send({
    sessionUpdate: 'usage_update',
    used: 12345,
    size: 200000,
    cost: { amount: 0.0123, currency: 'USD' },
  });
  await send({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Here is ' },
  });
  await send({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'the reply.' },
  });
  return { stopReason: 'end_turn' };
});

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
