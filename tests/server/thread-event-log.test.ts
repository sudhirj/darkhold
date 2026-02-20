import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createThreadEventLogStore } from '../../src/server/thread-event-log';

const tempDirs: string[] = [];

async function makeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'darkhold-test-'));
  tempDirs.push(dir);
  return createThreadEventLogStore(dir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('thread event log store', () => {
  it('appends and reads events in order', async () => {
    const store = await makeStore();
    await store.append('thread-1', '{"method":"turn/started"}');
    await store.append('thread-1', '{"method":"turn/completed"}');

    const events = await store.read('thread-1');
    expect(events).toEqual(['{"method":"turn/started"}', '{"method":"turn/completed"}']);
  });

  it('serializes concurrent appends with file locks', async () => {
    const store = await makeStore();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => store.append('thread-2', JSON.stringify({ method: 'event', seq: index + 1 }))),
    );

    const events = await store.read('thread-2');
    expect(events.length).toBe(50);

    const seqs = events.map((line) => JSON.parse(line).seq).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs[49]).toBe(50);
  });

  it('rehydrates from thread/read result by replacing prior cache', async () => {
    const store = await makeStore();
    await store.append('thread-3', '{"method":"stale"}');

    await store.rehydrateFromThreadRead('thread-3', {
      thread: {
        turns: [
          {
            items: [
              {
                type: 'userMessage',
                content: [{ type: 'text', text: 'hello' }],
              },
              {
                type: 'agentMessage',
                text: 'world',
              },
              {
                type: 'fileChange',
                changes: [{ path: 'a.txt', kind: 'modified' }],
              },
              {
                type: 'commandExecution',
                command: 'echo hi',
                status: 'completed',
              },
              {
                type: 'mcpToolCall',
                server: 'demo',
                tool: 'x',
              },
              {
                type: 'someFutureType',
              },
            ],
            status: 'failed',
            error: { message: 'boom' },
          },
        ],
      },
    });

    const events = await store.read('thread-3');
    expect(events.length).toBe(5);
    expect(events[0]).toContain('"method":"darkhold/thread-event"');
    expect(events[1]).toContain('"assistant.output"');
    expect(events[2]).toContain('"file.change"');
    expect(events[3]).toContain('"method":"turn/completed"');
    expect(events[4]).toContain('"turn.error"');
    expect(events.join('\n')).not.toContain('"stale"');
    expect(events.join('\n')).not.toContain('"command."');
    expect(events.join('\n')).not.toContain('"mcp.tool"');
    expect(events.join('\n')).not.toContain('"item.someFutureType"');
  });

  it('cleans up the event log root', async () => {
    const store = await makeStore();
    await store.append('thread-4', '{"method":"turn/started"}');
    await store.cleanup();

    const events = await store.read('thread-4');
    expect(events).toEqual([]);
  });
});
