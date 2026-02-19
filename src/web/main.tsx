import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { jsonFetch } from './api';
import { FolderBrowserDialog } from './components/folder-browser-dialog';
import { AgentThreadPanel } from './components/agent-thread-panel';
import { isConversationEvent, isTransientProgressEvent } from './session-utils';
import { AgentEvent, FolderEntry, FolderListing, Session, SessionStatus, SessionSummary } from './types';

type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type JsonRpcIncoming = JsonRpcRequest | JsonRpcResponse | { method: string; params?: unknown };

type ThreadListEntry = {
  id: string;
  cwd: string;
  updatedAt: number;
};

type ThreadReadTurn = {
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
  items: any[];
};

type ThreadReadResponse = {
  thread: {
    id: string;
    cwd: string;
    updatedAt: number;
    turns: ThreadReadTurn[];
  };
};

type UserInputQuestion = {
  id: string;
  question: string;
  options: string[];
};

type PendingUiRequest =
  | {
      kind: 'approval';
      title: string;
      description: string;
      command: string | null;
      resolve: (result: unknown) => void;
    }
  | {
      kind: 'user-input';
      title: string;
      questions: UserInputQuestion[];
      resolve: (result: unknown) => void;
    };

type PendingUiRequestDraft =
  | {
      kind: 'approval';
      title: string;
      description: string;
      command: string | null;
    }
  | {
      kind: 'user-input';
      title: string;
      questions: UserInputQuestion[];
    };

function nowIso(): string {
  return new Date().toISOString();
}

function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function statusFromTurnStatus(status: ThreadReadTurn['status']): SessionStatus {
  if (status === 'inProgress') {
    return 'running';
  }
  if (status === 'failed') {
    return 'error';
  }
  return 'idle';
}

function defaultAnswerForQuestion(question: UserInputQuestion): string {
  return question.options.length > 0 ? question.options[0] : '';
}

function summarizeThreadItem(item: any): { type: string; message: string } | null {
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
    return {
      type: 'user.input',
      message: text || '[non-text input]',
    };
  }

  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    return {
      type: 'assistant.output',
      message: item.text,
    };
  }

  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    const state = typeof item.status === 'string' ? item.status : 'updated';
    return {
      type: `command.${state}`,
      message: item.command,
    };
  }

  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    return {
      type: 'file.change',
      message: `${item.changes.length} file(s) changed`,
    };
  }

  if (item.type === 'mcpToolCall' && typeof item.tool === 'string') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    return {
      type: 'mcp.tool',
      message: `${server}.${item.tool}`,
    };
  }

  return {
    type: `item.${item.type}`,
    message: JSON.stringify(item),
  };
}

function buildSessionFromThreadRead(response: ThreadReadResponse): Session {
  const events: AgentEvent[] = [];
  let seq = 0;
  let completedItems = 0;
  let lastEventType: string | null = null;

  for (const turn of response.thread.turns) {
    for (const item of turn.items) {
      const summary = summarizeThreadItem(item);
      if (!summary) {
        continue;
      }
      seq += 1;
      events.push({
        seq,
        timestamp: nowIso(),
        type: summary.type,
        message: summary.message,
      });
      lastEventType = summary.type;
      if (summary.type === 'assistant.output') {
        completedItems += 1;
      }
    }

    if (turn.status === 'failed' && turn.error?.message) {
      seq += 1;
      events.push({
        seq,
        timestamp: nowIso(),
        type: 'turn.error',
        message: turn.error.message,
      });
      lastEventType = 'turn.error';
    }
  }

  const lastTurn = response.thread.turns[response.thread.turns.length - 1];
  const status = lastTurn ? statusFromTurnStatus(lastTurn.status) : 'idle';

  return {
    id: response.thread.id,
    cwd: response.thread.cwd,
    status,
    updatedAt: unixSecondsToIso(response.thread.updatedAt),
    threadId: response.thread.id,
    latestEventSeq: seq,
    progress: {
      completedItems,
      lastEventType,
    },
    events,
  };
}

class RpcClient {
  private ws: ReconnectingWebSocket | null = null;

  private nextId = 1;

  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeoutId: number }
  >();

  private requestHandler: ((request: JsonRpcRequest) => Promise<unknown>) | null = null;

  private notificationHandler: ((method: string, params: unknown) => void) | null = null;

  private closeHandler: (() => void) | null = null;

  private openHandler: (() => void) | null = null;

  private suppressCloseHandler = false;

  setRequestHandler(handler: (request: JsonRpcRequest) => Promise<unknown>) {
    this.requestHandler = handler;
  }

  setNotificationHandler(handler: (method: string, params: unknown) => void) {
    this.notificationHandler = handler;
  }

  setCloseHandler(handler: () => void) {
    this.closeHandler = handler;
  }

  setOpenHandler(handler: () => void) {
    this.openHandler = handler;
  }

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new ReconnectingWebSocket(url, [], {
        WebSocket,
        minReconnectionDelay: 150,
        maxReconnectionDelay: 1_500,
        reconnectionDelayGrowFactor: 1.25,
        minUptime: 500,
        connectionTimeout: 1_500,
        maxRetries: Infinity,
      });
      let resolved = false;
      ws.onopen = () => {
        this.ws = ws;
        if (!resolved) {
          resolved = true;
          resolve();
        }
        this.openHandler?.();
      };
      ws.onerror = () => {
        if (!resolved) {
          reject(new Error(`Failed to connect to Codex app-server at ${url}`));
        }
      };
      ws.onmessage = (event) => {
        void this.onMessage(event.data);
      };
      ws.onclose = () => {
        for (const [, pending] of this.pending) {
          window.clearTimeout(pending.timeoutId);
          pending.reject(new Error('RPC connection closed.'));
        }
        this.pending.clear();
        this.ws = null;
        if (this.suppressCloseHandler) {
          this.suppressCloseHandler = false;
          return;
        }
        this.closeHandler?.();
      };
    });
  }

  close(options?: { suppressHandler?: boolean }) {
    this.suppressCloseHandler = options?.suppressHandler ?? false;
    this.ws?.close();
    this.ws = null;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;

    const message: JsonRpcRequest = {
      id,
      method,
      params,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.reject(new Error(`RPC request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeoutId });
      this.send(message);
    });
  }

  private async onMessage(raw: unknown) {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      text = await raw.text();
    } else {
      text = String(raw);
    }

    let parsed: JsonRpcIncoming;
    try {
      parsed = JSON.parse(text) as JsonRpcIncoming;
    } catch {
      return;
    }

    if (typeof (parsed as JsonRpcResponse).id === 'number' && 'result' in parsed) {
      const response = parsed as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      window.clearTimeout(pending.timeoutId);
      pending.resolve(response.result);
      return;
    }

    if (typeof (parsed as JsonRpcResponse).id === 'number' && 'error' in parsed) {
      const response = parsed as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(response.error?.message ?? 'RPC error'));
      return;
    }

    if (typeof (parsed as JsonRpcRequest).id === 'number' && typeof (parsed as JsonRpcRequest).method === 'string') {
      const request = parsed as JsonRpcRequest;
      if (!this.requestHandler) {
        this.send({ id: request.id, error: { code: -32601, message: 'No request handler configured.' } });
        return;
      }
      try {
        const result = await this.requestHandler(request);
        this.send({ id: request.id, result });
      } catch (error: unknown) {
        this.send({
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (typeof (parsed as { method?: unknown }).method === 'string') {
      const notification = parsed as { method: string; params?: unknown };
      this.notificationHandler?.(notification.method, notification.params);
    }
  }

  private send(message: unknown) {
    if (!this.ws) {
      throw new Error('RPC connection is not open.');
    }
    this.ws.send(JSON.stringify(message));
  }
}

function App() {
  const [folderCache, setFolderCache] = useState<Record<string, FolderListing>>({});
  const [columnPaths, setColumnPaths] = useState<string[]>([]);
  const [columnSearch, setColumnSearch] = useState<Record<string, string>>({});
  const [columnSelections, setColumnSelections] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [activeUiRequest, setActiveUiRequest] = useState<PendingUiRequest | null>(null);
  const [uiAnswers, setUiAnswers] = useState<Record<string, string>>({});
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const folderInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const suppressNextAutoFocusRef = useRef(false);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const rpcRef = useRef<RpcClient | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const queuedUiRequestsRef = useRef<PendingUiRequest[]>([]);

  const activeSessionId = session?.id ?? '';
  const selectorLabel = session ? `${session.id.slice(0, 8)} · ${session.cwd}` : 'Select session';

  const basePath = columnPaths.length > 0 ? (folderCache[columnPaths[0]]?.root ?? null) : null;

  const conversationEvents = useMemo(
    () => (session?.events ?? []).filter((event) => isConversationEvent(event)),
    [session?.events],
  );

  const transientProgressEvents = useMemo(
    () =>
      session?.status === 'running'
        ? (session.events ?? []).filter((event) => isTransientProgressEvent(event)).slice(-5)
        : [],
    [session?.status, session?.events],
  );

  useEffect(() => {
    void initializeFolderBrowser();
    void connectRpc();

    const onOffline = () => {
      setError('Browser is offline. Waiting for network...');
      rpcRef.current?.close({ suppressHandler: true });
      rpcRef.current = null;
    };

    const onOnline = () => {
      setError('Network restored. Reconnecting...');
      void connectRpc();
    };

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      rpcRef.current?.close({ suppressHandler: true });
    };
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end' });
  }, [session?.latestEventSeq]);

  useEffect(() => {
    activeThreadIdRef.current = session?.threadId ?? null;
  }, [session?.threadId]);

  useEffect(() => {
    if (!session) {
      return;
    }
    promptInputRef.current?.focus();
  }, [session?.id]);

  useEffect(() => {
    if (!pendingFocusPath) {
      return;
    }
    const nextInput = folderInputRefs.current[pendingFocusPath];
    if (nextInput) {
      nextInput.focus();
      setPendingFocusPath(null);
    }
  }, [pendingFocusPath, columnPaths]);

  useEffect(() => {
    if (!activeUiRequest || activeUiRequest.kind !== 'user-input') {
      setUiAnswers({});
      return;
    }
    const defaults: Record<string, string> = {};
    for (const question of activeUiRequest.questions) {
      defaults[question.id] = defaultAnswerForQuestion(question);
    }
    setUiAnswers(defaults);
  }, [activeUiRequest]);

  function directoriesFor(listingPath: string): FolderEntry[] {
    const listing = folderCache[listingPath];
    if (!listing) {
      return [];
    }
    return listing.entries.filter((entry) => entry.kind === 'directory');
  }

  function pushEventToSession(threadId: string, type: string, message: string) {
    setSession((current) => {
      if (!current || current.threadId !== threadId) {
        return current;
      }

      const seq = current.latestEventSeq + 1;
      const nextEvents = [...current.events, { seq, timestamp: nowIso(), type, message }];
      const nextProgress = {
        completedItems: type === 'assistant.output' ? current.progress.completedItems + 1 : current.progress.completedItems,
        lastEventType: type,
      };

      return {
        ...current,
        latestEventSeq: seq,
        updatedAt: nowIso(),
        events: nextEvents,
        progress: nextProgress,
      };
    });
  }

  function setThreadStatus(threadId: string, status: SessionStatus) {
    setSessions((current) => current.map((item) => (item.id === threadId ? { ...item, status, updatedAt: nowIso() } : item)));
    setSession((current) => {
      if (!current || current.threadId !== threadId) {
        return current;
      }
      return {
        ...current,
        status,
        updatedAt: nowIso(),
      };
    });
  }

  function enqueueUiRequest(request: PendingUiRequestDraft): Promise<unknown> {
    return new Promise((resolve) => {
      const queued = { ...request, resolve } as PendingUiRequest;
      setActiveUiRequest((current) => {
        if (!current) {
          return queued;
        }
        queuedUiRequestsRef.current.push(queued);
        return current;
      });
    });
  }

  function popNextUiRequest() {
    const next = queuedUiRequestsRef.current.shift() ?? null;
    setActiveUiRequest(next);
  }

  function resolveActiveUiRequest(result: unknown) {
    if (!activeUiRequest) {
      return;
    }
    activeUiRequest.resolve(result);
    popNextUiRequest();
  }

  function declineApprovalRequest() {
    resolveActiveUiRequest({ decision: 'decline' });
  }

  function acceptApprovalRequest() {
    resolveActiveUiRequest({ decision: 'accept' });
  }

  function submitUserInputRequest() {
    if (!activeUiRequest || activeUiRequest.kind !== 'user-input') {
      return;
    }
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of activeUiRequest.questions) {
      const fallback = defaultAnswerForQuestion(question);
      const value = (uiAnswers[question.id] ?? fallback).trim() || fallback;
      answers[question.id] = { answers: [value] };
    }
    resolveActiveUiRequest({ answers });
  }

  function handleUiRequestClose() {
    if (!activeUiRequest) {
      return;
    }
    if (activeUiRequest.kind === 'approval') {
      declineApprovalRequest();
      return;
    }
    submitUserInputRequest();
  }

  async function handleServerRequest(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'execCommandApproval') {
      const params = (request.params ?? {}) as { command?: string | null };
      const command = params.command ?? 'Unknown command';
      return await enqueueUiRequest({
        kind: 'approval',
        title: 'Command Approval',
        description: 'Allow command execution?',
        command,
      });
    }

    if (request.method === 'item/fileChange/requestApproval' || request.method === 'applyPatchApproval') {
      return await enqueueUiRequest({
        kind: 'approval',
        title: 'File Change Approval',
        description: 'Allow requested file changes?',
        command: null,
      });
    }

    if (request.method === 'item/tool/requestUserInput') {
      const params = (request.params ?? {}) as { questions?: Array<{ id: string; question: string; options?: Array<{ label: string }> | null }> };
      const questions: UserInputQuestion[] = (params.questions ?? []).map((question) => ({
        id: question.id,
        question: question.question,
        options: (question.options ?? []).map((option) => option.label),
      }));
      return await enqueueUiRequest({
        kind: 'user-input',
        title: 'Codex Question',
        questions,
      });
    }

    throw new Error(`Unsupported server request: ${request.method}`);
  }

  function handleNotification(method: string, params: unknown) {
    const payload = (params ?? {}) as any;

    if (method === 'turn/started' && typeof payload.threadId === 'string') {
      setThreadStatus(payload.threadId, 'running');
      return;
    }

    if (method === 'turn/completed' && typeof payload.threadId === 'string') {
      const turnStatus = payload.turn?.status as string | undefined;
      const nextStatus: SessionStatus = turnStatus === 'failed' ? 'error' : 'idle';
      setThreadStatus(payload.threadId, nextStatus);
      if (nextStatus === 'error' && payload.turn?.error?.message) {
        pushEventToSession(payload.threadId, 'turn.error', payload.turn.error.message);
      }
      void refreshSessions();
      return;
    }

    if ((method === 'item/started' || method === 'item/completed') && payload.item) {
      if (payload.threadId !== activeThreadIdRef.current) {
        return;
      }
      if (method === 'item/started' && payload.item?.type === 'userMessage') {
        return;
      }
      const summary = summarizeThreadItem(payload.item);
      if (!summary) {
        return;
      }
      pushEventToSession(payload.threadId, summary.type, summary.message);
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
      if (payload.threadId !== activeThreadIdRef.current) {
        return;
      }
      pushEventToSession(payload.threadId, 'agent.delta', payload.delta);
      return;
    }

    if (method === 'error' && payload?.message) {
      setError(String(payload.message));
    }
  }

  async function initializeRpcSession(rpc: RpcClient) {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'darkhold-web',
        title: 'Darkhold Web',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    await refreshSessions(rpc);

    const activeThreadId = activeThreadIdRef.current;
    if (activeThreadId) {
      const response = await rpc.request<ThreadReadResponse>('thread/read', {
        threadId: activeThreadId,
        includeTurns: true,
      });
      setSession(buildSessionFromThreadRead(response));
    }
  }

  async function connectRpc() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError('Browser is offline. Waiting for network...');
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${protocol}://${window.location.host}/api/rpc/ws`;

      rpcRef.current?.close({ suppressHandler: true });
      const rpc = new RpcClient();
      rpc.setRequestHandler(handleServerRequest);
      rpc.setNotificationHandler(handleNotification);
      rpc.setCloseHandler(() => {
        setError('RPC connection lost. Reconnecting...');
      });
      rpc.setOpenHandler(() => {
        void (async () => {
          try {
            await initializeRpcSession(rpc);
            setError(null);
          } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })();
      });
      await rpc.connect(wsUrl);
      rpcRef.current = rpc;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadFolder(path?: string): Promise<FolderListing> {
    const next = await jsonFetch<FolderListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    setFolderCache((prev) => ({ ...prev, [next.path]: next }));
    return next;
  }

  async function initializeFolderBrowser() {
    try {
      setError(null);
      const homeListing = await loadFolder();
      setColumnPaths([homeListing.path]);
      setColumnSearch({});
      setColumnSelections({});
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSelectDirectory(columnIndex: number, listingPath: string, targetPath: string) {
    try {
      setError(null);
      const nextListing = await loadFolder(targetPath);
      setColumnSelections((prev) => ({ ...prev, [listingPath]: targetPath }));
      setColumnPaths((prev) => [...prev.slice(0, columnIndex + 1), nextListing.path]);
      if (suppressNextAutoFocusRef.current) {
        suppressNextAutoFocusRef.current = false;
      } else {
        setPendingFocusPath(nextListing.path);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshSessions(client?: RpcClient) {
    const rpc = client ?? rpcRef.current;
    if (!rpc) {
      return;
    }

    try {
      const result = await rpc.request<{ data: ThreadListEntry[] }>('thread/list', {
        limit: 50,
        archived: false,
      });

      setSessions((current) =>
        (result.data ?? [])
          .map((thread) => {
            const existing = current.find((item) => item.id === thread.id);
            return {
              id: thread.id,
              cwd: thread.cwd,
              updatedAt: unixSecondsToIso(thread.updatedAt),
              status: existing?.status ?? 'idle',
            };
          })
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startSessionForPath(targetPath: string) {
    const rpc = rpcRef.current;
    if (!rpc) {
      setError('RPC connection is not ready yet. Please wait for reconnect and try again.');
      return;
    }

    try {
      setError(null);
      const listing = await loadFolder(targetPath);
      const response = await rpc.request<{ thread: { id: string; cwd: string; updatedAt: number } }>('thread/start', {
        cwd: listing.path,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });

      const nextSession: Session = {
        id: response.thread.id,
        cwd: response.thread.cwd,
        status: 'idle',
        updatedAt: unixSecondsToIso(response.thread.updatedAt),
        threadId: response.thread.id,
        latestEventSeq: 0,
        progress: {
          completedItems: 0,
          lastEventType: null,
        },
        events: [],
      };

      setSession(nextSession);
      setIsFolderBrowserOpen(false);
      await refreshSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resumeSession(threadId: string) {
    const rpc = rpcRef.current;
    if (!rpc) {
      return;
    }

    try {
      setError(null);
      const response = await rpc.request<ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      });
      const loaded = buildSessionFromThreadRead(response);
      setSession(loaded);
      await refreshSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rpc = rpcRef.current;
    if (!rpc || !session || !prompt.trim()) {
      return;
    }

    const input = prompt.trim();

    try {
      setError(null);
      setPrompt('');
      pushEventToSession(session.threadId, 'user.input', input);
      setThreadStatus(session.threadId, 'running');

      await rpc.request('turn/start', {
        threadId: session.threadId,
        input: [
          {
            type: 'text',
            text: input,
            text_elements: [],
          },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setThreadStatus(session.threadId, 'error');
      pushEventToSession(session.threadId, 'turn.error', message);
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!session || !prompt.trim() || session.status === 'running') {
        return;
      }
      event.currentTarget.form?.requestSubmit();
    }
  }

  function openFolderBrowser() {
    setPendingFocusPath(null);
    void initializeFolderBrowser();
    setIsFolderBrowserOpen(true);
  }

  return (
    <>
      <nav className="navbar bg-body-tertiary border-bottom fixed-top">
        <div className="container-fluid px-3">
          <div className="d-flex align-items-center gap-2 w-100">
            {sessions.length > 0 ? (
              <Listbox
                value={activeSessionId}
                onChange={(nextSessionId) => {
                  if (nextSessionId) {
                    void resumeSession(nextSessionId);
                  }
                }}
              >
                <div className="position-relative flex-grow-1 min-w-0">
                  <ListboxButton
                    className="form-select form-select-sm text-start w-100 focus-ring focus-ring-primary"
                    aria-label="Select active session"
                    tabIndex={0}
                  >
                    <span className="text-truncate d-block w-100 pe-4">{selectorLabel}</span>
                  </ListboxButton>
                  <ListboxOptions className="position-absolute start-0 mt-1 w-100 border rounded bg-white shadow-sm p-1 z-3 folder-list">
                    {sessions.map((item) => (
                      <ListboxOption
                        key={item.id}
                        value={item.id}
                        className={({ focus, selected }) =>
                          `list-group-item border-0 rounded px-2 py-2 ${
                            selected ? 'active' : focus ? 'list-group-item-primary' : 'list-group-item-action'
                          }`
                        }
                      >
                        <div className="d-flex align-items-start justify-content-between gap-2">
                          <div className="text-start min-w-0">
                            <div className="small font-mono fw-semibold">{item.id.slice(0, 8)}</div>
                            <div className="small text-secondary text-truncate">{item.cwd}</div>
                          </div>
                          {item.id === activeSessionId ? <i className="bi bi-check2 mt-1" aria-hidden="true" /> : null}
                        </div>
                      </ListboxOption>
                    ))}
                  </ListboxOptions>
                </div>
              </Listbox>
            ) : (
              <button className="form-select form-select-sm text-start w-100" type="button" disabled>
                <span className="d-block text-secondary pe-4">No active sessions</span>
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              type="button"
              tabIndex={0}
              onClick={openFolderBrowser}
              aria-controls="folderBrowserPanel"
              aria-expanded={isFolderBrowserOpen}
              aria-label="Open folder browser"
              title="Open folder browser"
            >
              <i className="bi bi-folder2-open" aria-hidden="true" />
            </button>
          </div>
        </div>
      </nav>

      <FolderBrowserDialog
        isOpen={isFolderBrowserOpen}
        onClose={() => setIsFolderBrowserOpen(false)}
        basePath={basePath}
        columnPaths={columnPaths}
        columnSearch={columnSearch}
        columnSelections={columnSelections}
        folderCache={folderCache}
        folderInputRefs={folderInputRefs}
        suppressNextAutoFocusRef={suppressNextAutoFocusRef}
        onChangeSearch={(listingPath, value) =>
          setColumnSearch((prev) => ({
            ...prev,
            [listingPath]: value,
          }))
        }
        onSelectDirectory={onSelectDirectory}
        onOpenAgentForPath={startSessionForPath}
      />

      <main className="container-fluid px-3 py-3">
        {error ? <div className="alert alert-danger">{error}</div> : null}
        <AgentThreadPanel
          session={session}
          conversationEvents={conversationEvents}
          transientProgressEvents={transientProgressEvents}
          conversationEndRef={conversationEndRef}
          promptInputRef={promptInputRef}
          prompt={prompt}
          onSubmitPrompt={submitPrompt}
          onPromptKeyDown={handlePromptKeyDown}
          onPromptChange={setPrompt}
        />
      </main>

      {activeUiRequest ? (
        <Dialog open onClose={handleUiRequestClose} className="position-relative">
          <DialogBackdrop className="modal-backdrop fade show" />
          <div className="modal fade show d-block position-fixed top-0 start-0 w-100 h-100" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <DialogPanel className="modal-content">
                <div className="modal-header">
                  <DialogTitle as="h2" className="modal-title h5 mb-0">
                    {activeUiRequest.title}
                  </DialogTitle>
                </div>
                <div className="modal-body">
                  {activeUiRequest.kind === 'approval' ? (
                    <>
                      <p className="mb-2">{activeUiRequest.description}</p>
                      {activeUiRequest.command ? <pre className="form-control font-mono small mb-0">{activeUiRequest.command}</pre> : null}
                    </>
                  ) : (
                    <div className="d-flex flex-column gap-3">
                      {activeUiRequest.questions.map((question) => (
                        <div key={question.id}>
                          <label className="form-label small fw-semibold">{question.question}</label>
                          <input
                            className="form-control form-control-sm"
                            list={`ui-question-options-${question.id}`}
                            value={uiAnswers[question.id] ?? defaultAnswerForQuestion(question)}
                            onChange={(event) =>
                              setUiAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))
                            }
                          />
                          {question.options.length > 0 ? (
                            <datalist id={`ui-question-options-${question.id}`}>
                              {question.options.map((option) => (
                                <option key={option} value={option} />
                              ))}
                            </datalist>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="modal-footer">
                  {activeUiRequest.kind === 'approval' ? (
                    <>
                      <button type="button" className="btn btn-outline-secondary btn-sm" onClick={declineApprovalRequest}>
                        Decline
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={acceptApprovalRequest}>
                        Approve
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-primary btn-sm" onClick={submitUserInputRequest}>
                      Submit
                    </button>
                  )}
                </div>
              </DialogPanel>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing root element.');
}

createRoot(root).render(<App />);
