import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import '@ibm/plex/css/ibm-plex.css';
import './styles.css';
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

function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('thread not found');
}

function readSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');
  return sessionId && sessionId.trim().length > 0 ? sessionId : null;
}

function writeSessionIdToUrl(sessionId: string | null) {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set('session', sessionId);
  } else {
    url.searchParams.delete('session');
  }
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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

function syntheticReadTurnId(threadId: string, turnIndex: number): string {
  return `read-turn:${threadId}:${turnIndex}`;
}

function extractTurnId(payload: any): string | null {
  if (typeof payload?.turnId === 'string') {
    return payload.turnId;
  }
  if (typeof payload?.turn?.id === 'string') {
    return payload.turn.id;
  }
  return null;
}

function nextCompletedTurnNumber(current: Session | null, threadId: string): number {
  if (!current || current.threadId !== threadId) {
    return 1;
  }
  return current.events.filter((event) => event.type === 'turn.completed').length + 1;
}

function buildSessionFromThreadRead(response: ThreadReadResponse): Session {
  const events: AgentEvent[] = [];
  let seq = 0;
  let completedItems = 0;
  let lastEventType: string | null = null;

  for (let turnIndex = 0; turnIndex < response.thread.turns.length; turnIndex += 1) {
    const turn = response.thread.turns[turnIndex];
    const turnId = syntheticReadTurnId(response.thread.id, turnIndex);
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
        turnId,
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
        turnId,
      });
      lastEventType = 'turn.error';
    }

    seq += 1;
    events.push({
      seq,
      timestamp: nowIso(),
      type: 'turn.completed',
      message: `${turnIndex + 1}`,
      turnId,
    });
    lastEventType = 'turn.completed';
  }

  const lastTurn = response.thread.turns[response.thread.turns.length - 1];
  const status = lastTurn ? statusFromTurnStatus(lastTurn.status) : 'idle';
  const currentTurnId =
    lastTurn?.status === 'inProgress' ? syntheticReadTurnId(response.thread.id, response.thread.turns.length - 1) : null;

  return {
    id: response.thread.id,
    cwd: response.thread.cwd,
    status,
    updatedAt: unixSecondsToIso(response.thread.updatedAt),
    threadId: response.thread.id,
    currentTurnId,
    latestEventSeq: seq,
    progress: {
      completedItems,
      lastEventType,
    },
    events,
  };
}

async function rpcPost<T = unknown>(method: string, params?: unknown): Promise<T> {
  return await jsonFetch<T>('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
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
  const [isThinkingDialogOpen, setIsThinkingDialogOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [activeUiRequest, setActiveUiRequest] = useState<PendingUiRequest | null>(null);
  const [uiAnswers, setUiAnswers] = useState<Record<string, string>>({});
  const [isSentinelInView, setIsSentinelInView] = useState(false);
  const [promptDockHeightPx, setPromptDockHeightPx] = useState(0);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const promptDockRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const folderInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const suppressNextAutoFocusRef = useRef(false);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const threadEventsSourceRef = useRef<EventSource | null>(null);
  const threadEventsSourceThreadIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const queuedUiRequestsRef = useRef<PendingUiRequest[]>([]);
  const shouldStickToBottomRef = useRef(true);
  const activeTurnByThreadRef = useRef<Map<string, string>>(new Map());

  const activeSessionId = session?.id ?? '';
  const selectorLabel = session ? `${session.id.slice(0, 8)} · ${session.cwd}` : 'Select session';

  const basePath = columnPaths.length > 0 ? (folderCache[columnPaths[0]]?.root ?? null) : null;

  const conversationEvents = useMemo(
    () => (session?.events ?? []).filter((event) => isConversationEvent(event)),
    [session?.events],
  );

  const thinkingEvents = useMemo(
    () =>
      session?.currentTurnId
        ? (session.events ?? [])
            .filter((event) => event.turnId === session.currentTurnId && isTransientProgressEvent(event))
            .slice(-200)
        : [],
    [session?.currentTurnId, session?.events],
  );

  const isLiveWorkActive = session?.status === 'running';

  useEffect(() => {
    void initializeFolderBrowser();
    void refreshSessions();
    const activeThreadId = readSessionIdFromUrl();
    if (activeThreadId) {
      void resumeSession(activeThreadId, { updateUrl: true });
    }

    const onOffline = () => {
      setError('Browser is offline. Waiting for network...');
    };

    const onOnline = () => {
      setError('Network restored. Reconnecting...');
      void refreshSessions();
      const activeThreadId = readSessionIdFromUrl();
      if (activeThreadId) {
        void resumeSession(activeThreadId, { updateUrl: true });
      }
    };

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      threadEventsSourceRef.current?.close();
      threadEventsSourceRef.current = null;
      threadEventsSourceThreadIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const promptDock = promptDockRef.current;
    if (!promptDock) {
      return;
    }

    const rootStyle = document.documentElement.style;
    const updatePromptDockHeight = () => {
      const measuredHeight = promptDock.getBoundingClientRect().height;
      rootStyle.setProperty('--prompt-dock-height', `${measuredHeight}px`);
      setPromptDockHeightPx(measuredHeight);
    };

    updatePromptDockHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updatePromptDockHeight);
      return () => {
        window.removeEventListener('resize', updatePromptDockHeight);
      };
    }

    const observer = new ResizeObserver(() => {
      updatePromptDockHeight();
    });
    observer.observe(promptDock);
    return () => {
      observer.disconnect();
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session) {
      shouldStickToBottomRef.current = true;
      setIsSentinelInView(false);
      return;
    }
    const sentinel = conversationEndRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const isInView = entries.some((entry) => entry.isIntersecting);
        shouldStickToBottomRef.current = isInView;
        setIsSentinelInView(isInView);
      },
      {
        threshold: 0.9,
      },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session) {
      return;
    }
    requestAnimationFrame(() => {
      conversationEndRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
    });
  }, [session?.id, session?.latestEventSeq]);

  useEffect(() => {
    activeThreadIdRef.current = session?.threadId ?? null;
  }, [session?.threadId]);

  useEffect(() => {
    const threadId = session?.threadId ?? null;
    if (!threadId) {
      threadEventsSourceRef.current?.close();
      threadEventsSourceRef.current = null;
      threadEventsSourceThreadIdRef.current = null;
      return;
    }
    if (threadEventsSourceRef.current && threadEventsSourceThreadIdRef.current === threadId) {
      return;
    }

    threadEventsSourceRef.current?.close();
    const source = new EventSource(`/api/thread/events/stream?threadId=${encodeURIComponent(threadId)}`);
    source.onmessage = (event) => {
      let parsed: { method?: string; params?: unknown };
      try {
        parsed = JSON.parse(event.data) as { method?: string; params?: unknown };
      } catch {
        return;
      }
      if (typeof parsed.method !== 'string') {
        return;
      }
      handleNotification(parsed.method, parsed.params);
    };
    source.onerror = () => {
      // Browser will reconnect automatically and resume from Last-Event-ID.
    };
    threadEventsSourceRef.current = source;
    threadEventsSourceThreadIdRef.current = threadId;

    return () => {
      source.close();
      if (threadEventsSourceRef.current === source) {
        threadEventsSourceRef.current = null;
      }
      if (threadEventsSourceThreadIdRef.current === threadId) {
        threadEventsSourceThreadIdRef.current = null;
      }
    };
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

  function pushEventToSession(threadId: string, type: string, message: string, turnIdOverride?: string | null) {
    const turnId = turnIdOverride ?? activeTurnByThreadRef.current.get(threadId) ?? null;
    setSession((current) => {
      if (!current || current.threadId !== threadId) {
        return current;
      }

      const seq = current.latestEventSeq + 1;
      const nextEventsWithTurn = [...current.events, { seq, timestamp: nowIso(), type, message, turnId }];
      const nextProgress = {
        completedItems: type === 'assistant.output' ? current.progress.completedItems + 1 : current.progress.completedItems,
        lastEventType: type,
      };

      return {
        ...current,
        latestEventSeq: seq,
        updatedAt: nowIso(),
        events: nextEventsWithTurn,
        progress: nextProgress,
      };
    });
  }

  function setThreadCurrentTurn(threadId: string, turnId: string | null) {
    if (turnId) {
      activeTurnByThreadRef.current.set(threadId, turnId);
    } else {
      activeTurnByThreadRef.current.delete(threadId);
    }
    setSession((current) => {
      if (!current || current.threadId !== threadId) {
        return current;
      }
      return {
        ...current,
        currentTurnId: turnId,
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

  async function handleThreadInteractionRequest(payload: any): Promise<void> {
    const threadId = typeof payload?.threadId === 'string' ? payload.threadId : '';
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const method = typeof payload?.method === 'string' ? payload.method : '';
    if (!threadId || !requestId || !method) {
      return;
    }

    try {
      const result = await handleServerRequest({ id: 0, method, params: payload?.params });
      await jsonFetch<{ ok: boolean }>('/api/thread/interaction/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, requestId, result }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await jsonFetch<{ ok: boolean }>('/api/thread/interaction/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, requestId, error: { message } }),
      }).catch(() => {});
    }
  }

  function handleNotification(method: string, params: unknown) {
    const payload = (params ?? {}) as any;

    if (method === 'darkhold/interaction/request') {
      void handleThreadInteractionRequest(payload);
      return;
    }

    if (method === 'turn/started' && typeof payload.threadId === 'string') {
      const turnId = extractTurnId(payload) ?? `live-turn:${payload.threadId}:${Date.now()}`;
      setThreadCurrentTurn(payload.threadId, turnId);
      setThreadStatus(payload.threadId, 'running');
      return;
    }

    if (method === 'turn/completed' && typeof payload.threadId === 'string') {
      const completedTurnId = extractTurnId(payload);
      const activeTurnId = activeTurnByThreadRef.current.get(payload.threadId) ?? null;
      const eventTurnId = completedTurnId ?? activeTurnId;
      if (!completedTurnId || !activeTurnId || completedTurnId === activeTurnId) {
        setThreadCurrentTurn(payload.threadId, null);
      }
      const turnStatus = payload.turn?.status as string | undefined;
      const nextStatus: SessionStatus = turnStatus === 'failed' ? 'error' : 'idle';
      pushEventToSession(payload.threadId, 'turn.completed', `${nextCompletedTurnNumber(session, payload.threadId)}`, eventTurnId);
      setThreadStatus(payload.threadId, nextStatus);
      if (nextStatus === 'error' && payload.turn?.error?.message) {
        pushEventToSession(payload.threadId, 'turn.error', payload.turn.error.message, eventTurnId);
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
      pushEventToSession(payload.threadId, summary.type, summary.message, extractTurnId(payload));
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
      if (payload.threadId !== activeThreadIdRef.current) {
        return;
      }
      pushEventToSession(payload.threadId, 'agent.delta', payload.delta, extractTurnId(payload));
      return;
    }

    if (method === 'error' && payload?.message) {
      setError(String(payload.message));
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

  async function refreshSessions() {
    try {
      const result = await rpcPost<{ data: ThreadListEntry[] }>('thread/list', {
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
    try {
      setError(null);
      const listing = await loadFolder(targetPath);
      const response = await rpcPost<{ thread: { id: string; cwd: string; updatedAt: number } }>('thread/start', {
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
        currentTurnId: null,
        latestEventSeq: 0,
        progress: {
          completedItems: 0,
          lastEventType: null,
        },
        events: [],
      };

      setSession(nextSession);
      writeSessionIdToUrl(nextSession.threadId);
      setIsFolderBrowserOpen(false);
      await refreshSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resumeSession(threadId: string, options?: { updateUrl?: boolean }) {
    try {
      setError(null);
      let response: ThreadReadResponse;
      try {
        response = await rpcPost<ThreadReadResponse>('thread/resume', {
          threadId,
        });
      } catch {
        response = await rpcPost<ThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: true,
        });
      }
      const loaded = buildSessionFromThreadRead(response);
      setSession(loaded);
      setThreadCurrentTurn(threadId, loaded.currentTurnId);
      if (options?.updateUrl !== false) {
        writeSessionIdToUrl(threadId);
      }
      await refreshSessions();
    } catch (err: unknown) {
      if (options?.updateUrl !== false && isThreadNotFoundError(err)) {
        writeSessionIdToUrl(null);
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !prompt.trim()) {
      return;
    }

    const input = prompt.trim();

    try {
      setError(null);
      setPrompt('');
      setThreadStatus(session.threadId, 'running');

      const turnParams = {
        threadId: session.threadId,
        input: [
          {
            type: 'text',
            text: input,
            text_elements: [],
          },
        ],
      };

      try {
        await rpcPost('turn/start', turnParams);
      } catch (error: unknown) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }
        await rpcPost('thread/resume', { threadId: session.threadId });
        await rpcPost('turn/start', turnParams);
      }
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
          conversationEndRef={conversationEndRef}
          promptDockRef={promptDockRef}
          promptInputRef={promptInputRef}
          prompt={prompt}
          onSubmitPrompt={submitPrompt}
          onPromptKeyDown={handlePromptKeyDown}
          onPromptChange={setPrompt}
        />
      </main>

      {session ? (
        <button
          type="button"
          className={`btn btn-light border shadow-sm thinking-fab d-inline-flex align-items-center gap-2 ${
            isLiveWorkActive ? 'is-active' : ''
          }`}
          onClick={() => setIsThinkingDialogOpen(true)}
          aria-label="Show thinking events"
          title="Show thinking events"
        >
          <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
          <span className="small fw-semibold">{thinkingEvents.length}</span>
        </button>
      ) : null}

      <aside
        className="position-fixed top-0 end-0 mt-5 me-3 p-2 border rounded bg-light shadow-sm font-mono small"
        style={{ zIndex: 1055, minWidth: '220px', opacity: 0.9 }}
        aria-label="Scroll debug panel"
      >
        <div className="fw-semibold mb-1">Debug</div>
        <div>sentinelInView: {isSentinelInView ? 'yes' : 'no'}</div>
        <div>promptDockHeight: {Math.round(promptDockHeightPx)}px</div>
        <div>liveActive: {isLiveWorkActive ? 'yes' : 'no'}</div>
      </aside>

      {isThinkingDialogOpen ? (
        <Dialog open onClose={() => setIsThinkingDialogOpen(false)} className="position-relative">
          <DialogBackdrop className="modal-backdrop fade show" />
          <div className="modal fade show d-block position-fixed top-0 start-0 w-100 h-100" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-scrollable modal-lg modal-dialog-centered">
              <DialogPanel className="modal-content">
                <div className="modal-header">
                  <DialogTitle as="h2" className="modal-title h5 mb-0">
                    Thinking Events
                  </DialogTitle>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setIsThinkingDialogOpen(false)} />
                </div>
                <div className="modal-body">
                  {thinkingEvents.length === 0 ? <p className="text-secondary mb-0">No thinking events yet.</p> : null}
                  {thinkingEvents.length > 0 ? (
                    <ul className="list-group">
                      {thinkingEvents.map((event) => (
                        <li key={event.seq} className="list-group-item">
                          <div className="small font-mono text-secondary mb-1">{event.type}</div>
                          <pre className="mb-0 chat-text">{event.message}</pre>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </DialogPanel>
            </div>
          </div>
        </Dialog>
      ) : null}

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
