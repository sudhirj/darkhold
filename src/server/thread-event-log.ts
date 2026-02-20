import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function summarizeThreadReadItem(item: any): { type: string; message: string } | null {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') {
    return null;
  }
  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .filter((entry: any) => entry?.type === 'text' && typeof entry?.text === 'string')
      .map((entry: any) => entry.text)
      .join('\n')
      .trim();
    return { type: 'user.input', message: text || '[non-text input]' };
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    return { type: 'assistant.output', message: item.text };
  }
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    const state = typeof item.status === 'string' ? item.status : 'updated';
    return { type: `command.${state}`, message: item.command };
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    return { type: 'file.change', message: `${item.changes.length} file(s) changed` };
  }
  if (item.type === 'mcpToolCall' && typeof item.tool === 'string') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    return { type: 'mcp.tool', message: `${server}.${item.tool}` };
  }
  return { type: `item.${item.type}`, message: JSON.stringify(item) };
}

export type ThreadEventLogStore = {
  append: (threadId: string, payload: string) => Promise<void>;
  read: (threadId: string) => Promise<string[]>;
  rehydrateFromThreadRead: (threadId: string, readResult: any) => Promise<void>;
  cleanup: () => Promise<void>;
  rootDir: string;
};

export function createThreadEventLogStore(rootDir: string): ThreadEventLogStore {
  function filePath(threadId: string): string {
    return path.join(rootDir, `${sanitizeThreadId(threadId)}.jsonl`);
  }

  function lockPath(threadId: string): string {
    return path.join(rootDir, `${sanitizeThreadId(threadId)}.lock`);
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withThreadFileLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const lock = lockPath(threadId);
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error;
        }
        await sleep(8);
      }
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  return {
    rootDir,
    async append(threadId: string, payload: string): Promise<void> {
      await withThreadFileLock(threadId, async () => {
        await appendFile(filePath(threadId), `${payload}\n`, 'utf8');
      });
    },
    async read(threadId: string): Promise<string[]> {
      try {
        const content = await readFile(filePath(threadId), 'utf8');
        return content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    },
    async rehydrateFromThreadRead(threadId: string, readResult: any): Promise<void> {
      const turns = Array.isArray(readResult?.thread?.turns) ? readResult.thread.turns : null;
      if (!turns) {
        return;
      }
      const lines: string[] = [];
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
        const turn = turns[turnIndex];
        const items = Array.isArray(turn?.items) ? turn.items : [];
        for (const item of items) {
          const summary = summarizeThreadReadItem(item);
          if (!summary) {
            continue;
          }
          lines.push(
            JSON.stringify({
              method: 'darkhold/thread-event',
              params: { threadId, type: summary.type, message: summary.message, source: 'thread/read' },
            }),
          );
        }
        lines.push(
          JSON.stringify({
            method: 'turn/completed',
            params: { threadId, source: 'thread/read', turnNumber: turnIndex + 1 },
          }),
        );
      }
      const payload = lines.length > 0 ? `${lines.join('\n')}\n` : '';
      await withThreadFileLock(threadId, async () => {
        await writeFile(filePath(threadId), payload, 'utf8');
      });
    },
    async cleanup(): Promise<void> {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

