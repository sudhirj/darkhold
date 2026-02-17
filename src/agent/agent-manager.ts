import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';

type SessionStatus = 'idle' | 'running' | 'error';

type AgentEvent = {
  seq: number;
  timestamp: string;
  type: string;
  message: string;
};

type AgentProgress = {
  completedItems: number;
  lastEventType: string | null;
};

type SessionState = {
  id: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  threadId: string | null;
  events: AgentEvent[];
  progress: AgentProgress;
  thread: any;
};

const MAX_EVENTS = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeEvent(event: any): string {
  if (typeof event?.text === 'string') {
    return event.text;
  }
  if (typeof event?.message === 'string') {
    return event.message;
  }
  if (typeof event?.delta === 'string') {
    return event.delta;
  }
  if (typeof event?.error?.message === 'string') {
    return event.error.message;
  }
  const encoded = safeStringify(event);
  return encoded.length > 2000 ? `${encoded.slice(0, 2000)}...` : encoded;
}

export class AgentManager {
  private readonly codex: Codex;
  private readonly sessions = new Map<string, SessionState>();

  constructor() {
    this.codex = new Codex();
  }

  startSession(cwd: string): SessionState {
    const thread = this.codex.startThread({
      workingDirectory: cwd,
      skipGitRepoCheck: true,
    });

    const id = randomUUID();
    const createdAt = nowIso();

    const session: SessionState = {
      id,
      cwd,
      status: 'idle',
      createdAt,
      updatedAt: createdAt,
      threadId: thread.id ?? null,
      events: [],
      progress: {
        completedItems: 0,
        lastEventType: null,
      },
      thread,
    };

    this.sessions.set(id, session);
    this.pushEvent(session, 'session.created', `Session started for ${cwd}`);

    return session;
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => this.toPublicSession(session));
  }

  getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? this.toPublicSession(session) : null;
  }

  submitInput(sessionId: string, input: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.status === 'running') {
      throw new Error('Session is already running.');
    }

    this.runTurn(session, input).catch((error: unknown) => {
      session.status = 'error';
      session.updatedAt = nowIso();
      this.pushEvent(session, 'turn.error', error instanceof Error ? error.message : String(error));
    });
  }

  getEventsSince(sessionId: string, since = 0) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return session.events.filter((event) => event.seq > since);
  }

  private async runTurn(session: SessionState, input: string): Promise<void> {
    session.status = 'running';
    session.updatedAt = nowIso();
    this.pushEvent(session, 'user.input', input);

    const streamed = await session.thread.runStreamed(input);

    for await (const event of streamed.events) {
      const eventType = String(event?.type ?? 'event');
      if (eventType === 'thread.started' && typeof event?.thread_id === 'string') {
        session.threadId = event.thread_id;
      }
      this.pushEvent(session, eventType, summarizeEvent(event));
      session.progress.lastEventType = eventType;
      if (eventType === 'item.completed') {
        session.progress.completedItems += 1;
      }
    }

    if (!session.threadId && typeof session.thread?.id === 'string') {
      session.threadId = session.thread.id;
    }

    session.status = 'idle';
    session.updatedAt = nowIso();
    this.pushEvent(session, 'turn.completed', 'Turn completed.');
  }

  private pushEvent(session: SessionState, type: string, message: string) {
    const event: AgentEvent = {
      seq: session.events.length === 0 ? 1 : session.events[session.events.length - 1].seq + 1,
      timestamp: nowIso(),
      type,
      message,
    };

    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    session.updatedAt = nowIso();
  }

  private toPublicSession(session: SessionState) {
    return {
      id: session.id,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      threadId: session.threadId,
      progress: session.progress,
      latestEventSeq: session.events.length === 0 ? 0 : session.events[session.events.length - 1].seq,
      events: session.events,
    };
  }
}
