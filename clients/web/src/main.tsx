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
import { isConversationEvent, isTransientProgressEvent } from './thread-utils';
import { AgentEvent, FolderEntry, FolderListing, ThreadState, ThreadSummary } from './types';

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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeThreadListEntry(raw: any): ThreadListEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.threadId === 'string' ? raw.threadId : '';
  if (!id) {
    return null;
  }
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : typeof raw.path === 'string' ? raw.path : '';
  const updatedAt =
    toNumber(raw.updatedAt) ?? toNumber(raw.updated_at) ?? toNumber(raw.lastUpdatedAt) ?? toNumber(raw.timestamp) ?? Math.floor(Date.now() / 1000);
  return { id, cwd, updatedAt };
}

function extractThreadList(result: any): ThreadListEntry[] {
  const candidates = [result?.data, result?.threads, result?.conversations, result?.items];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    return candidate.map(normalizeThreadListEntry).filter((entry): entry is ThreadListEntry => entry !== null);
  }
  return [];
}

function defaultAnswerForQuestion(question: UserInputQuestion): string {
  return question.options.length > 0 ? question.options[0] : '';
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('thread not found');
}

function readThreadIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const threadId = params.get('thread');
  return threadId && threadId.trim().length > 0 ? threadId : null;
}

function writeThreadIdToUrl(threadId: string | null) {
  const url = new URL(window.location.href);
  if (threadId) {
    url.searchParams.set('thread', threadId);
  } else {
    url.searchParams.delete('thread');
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

function buildThreadFromThreadRead(response: ThreadReadResponse): ThreadState {
  const events: AgentEvent[] = [];
  let seq = 0;

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
    }
  }

  return {
    id: response.thread.id,
    cwd: response.thread.cwd,
    updatedAt: unixSecondsToIso(response.thread.updatedAt),
    threadId: response.thread.id,
    latestEventSeq: seq,
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
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [activeUiRequest, setActiveUiRequest] = useState<PendingUiRequest | null>(null);
  const [uiAnswers, setUiAnswers] = useState<Record<string, string>>({});
  const [isSentinelInView, setIsSentinelInView] = useState(false);
  const [promptDockHeightPx, setPromptDockHeightPx] = useState(0);
  const [isDebugPanelOpen, setIsDebugPanelOpen] = useState(false);
  const [assistantTypingText, setAssistantTypingText] = useState('');
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

  const basePath = columnPaths.length > 0 ? (folderCache[columnPaths[0]]?.root ?? null) : null;

  const conversationEvents = useMemo(
    () => (thread?.events ?? []).filter((event) => isConversationEvent(event)),
    [thread?.events],
  );
  const thinkingEvents = useMemo(() => (thread?.events ?? []).filter((event) => isTransientProgressEvent(event)), [thread?.events]);
  const activeThreadId = thread?.threadId ?? null;
  const selectorLabel = thread ? `${thread.id.slice(0, 8)} · ${thread.cwd}` : 'Select a thread';
  const isLiveWorkActive = assistantTypingText.trim().length > 0;
  const [isThinkingDialogOpen, setIsThinkingDialogOpen] = useState(false);

  useEffect(() => {
    void initializeFolderBrowser();
    void refreshThreads();
    const activeThreadId = readThreadIdFromUrl();
    if (activeThreadId) {
      void resumeThread(activeThreadId, { updateUrl: true });
    }

    const onOffline = () => {
      setError('Browser is offline. Waiting for network...');
    };

    const onOnline = () => {
      setError('Network restored. Reconnecting...');
      void refreshThreads();
      const activeThreadId = readThreadIdFromUrl();
      if (activeThreadId) {
        void resumeThread(activeThreadId, { updateUrl: true });
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
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) {
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
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) {
      return;
    }
    requestAnimationFrame(() => {
      conversationEndRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
    });
  }, [thread?.id, thread?.latestEventSeq]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setIsDebugPanelOpen((current) => !current);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    activeThreadIdRef.current = thread?.threadId ?? null;
  }, [thread?.threadId]);

  useEffect(() => {
    const threadId = thread?.threadId ?? null;
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
  }, [thread?.threadId]);

  useEffect(() => {
    if (!thread) {
      return;
    }
    promptInputRef.current?.focus();
  }, [thread?.id]);

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

  function pushEventToThread(threadId: string, type: string, message: string, turnId: string | null = null) {
    setThread((current) => {
      if (!current || current.threadId !== threadId) {
        return current;
      }

      const seq = current.latestEventSeq + 1;
      const nextEventsWithTurn = [...current.events, { seq, timestamp: nowIso(), type, message, turnId }];

      return {
        ...current,
        latestEventSeq: seq,
        updatedAt: nowIso(),
        events: nextEventsWithTurn,
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

    if (method === 'turn/completed' && typeof payload.threadId === 'string') {
      const turnStatus = typeof payload.turn?.status === 'string' ? payload.turn.status : '';
      if (turnStatus === 'failed' && payload.turn?.error?.message) {
        pushEventToThread(payload.threadId, 'turn.error', payload.turn.error.message, extractTurnId(payload));
      }
      void refreshThreads();
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
      if (summary.type === 'assistant.output') {
        setAssistantTypingText('');
      }
      pushEventToThread(payload.threadId, summary.type, summary.message, extractTurnId(payload));
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
      if (payload.threadId !== activeThreadIdRef.current) {
        return;
      }
      setAssistantTypingText((current) => current + payload.delta);
      pushEventToThread(payload.threadId, 'agent.delta', payload.delta, extractTurnId(payload));
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

  async function refreshThreads() {
    try {
      const result = await rpcPost<any>('thread/list', {
        limit: 50,
        archived: false,
      });
      const listedThreads = extractThreadList(result);

      setThreads((current) =>
        (listedThreads.length > 0 ? listedThreads : current)
          .map((thread) => ({
            id: thread.id,
            cwd: thread.cwd,
            updatedAt: typeof thread.updatedAt === 'number' ? unixSecondsToIso(thread.updatedAt) : thread.updatedAt,
          }))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startThreadForPath(targetPath: string) {
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

      const nextThread: ThreadState = {
        id: response.thread.id,
        cwd: response.thread.cwd,
        updatedAt: unixSecondsToIso(response.thread.updatedAt),
        threadId: response.thread.id,
        latestEventSeq: 0,
        events: [],
      };

      setThread(nextThread);
      writeThreadIdToUrl(nextThread.threadId);
      setIsFolderBrowserOpen(false);
      await refreshThreads();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resumeThread(threadId: string, options?: { updateUrl?: boolean }) {
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
      const loaded = buildThreadFromThreadRead(response);
      setThread(loaded);
      if (options?.updateUrl !== false) {
        writeThreadIdToUrl(threadId);
      }
      await refreshThreads();
    } catch (err: unknown) {
      if (options?.updateUrl !== false && isThreadNotFoundError(err)) {
        writeThreadIdToUrl(null);
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function selectThreadSummary(threadId: string) {
    const summary = threads.find((item) => item.id === threadId);
    if (!summary) {
      return;
    }
    setThread({
      id: summary.id,
      cwd: summary.cwd,
      updatedAt: summary.updatedAt,
      threadId: summary.id,
      latestEventSeq: 0,
      events: [],
    });
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || !prompt.trim()) {
      return;
    }

    const input = prompt.trim();

    try {
      setError(null);
      setPrompt('');

      const turnParams = {
        threadId: thread.threadId,
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
        await rpcPost('thread/resume', { threadId: thread.threadId });
        await rpcPost('turn/start', turnParams);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushEventToThread(thread.threadId, 'turn.error', message);
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!thread || !prompt.trim()) {
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
            {threads.length > 0 ? (
              <Listbox
                value={activeThreadId}
                onChange={(nextThreadId) => {
                  if (nextThreadId) {
                    selectThreadSummary(nextThreadId);
                    void resumeThread(nextThreadId);
                  }
                }}
              >
                <div className="position-relative flex-grow-1 min-w-0">
                  <ListboxButton
                    className="form-select form-select-sm text-start w-100 focus-ring focus-ring-primary"
                    aria-label="Select active thread"
                    tabIndex={0}
                  >
                    <span className="text-truncate d-block w-100 pe-4">{selectorLabel}</span>
                  </ListboxButton>
                  <ListboxOptions className="position-absolute start-0 mt-1 w-100 border rounded bg-white shadow-sm p-1 z-3 folder-list">
                    {threads.map((item) => (
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
                          {item.id === activeThreadId ? <i className="bi bi-check2 mt-1" aria-hidden="true" /> : null}
                        </div>
                      </ListboxOption>
                    ))}
                  </ListboxOptions>
                </div>
              </Listbox>
            ) : (
              <button className="form-select form-select-sm text-start w-100" type="button" disabled>
                <span className="d-block text-secondary pe-4">No active threads</span>
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
        onOpenAgentForPath={startThreadForPath}
      />

      <main className="container-fluid px-3 py-3">
        {error ? <div className="alert alert-danger">{error}</div> : null}
        <AgentThreadPanel
          thread={thread}
          conversationEvents={conversationEvents}
          assistantTypingText={assistantTypingText}
          conversationEndRef={conversationEndRef}
          promptDockRef={promptDockRef}
          promptInputRef={promptInputRef}
          prompt={prompt}
          onSubmitPrompt={submitPrompt}
          onPromptKeyDown={handlePromptKeyDown}
          onPromptChange={setPrompt}
        />
      </main>

      {thread ? (
        <button
          type="button"
          className={`btn btn-light border shadow-sm thinking-fab d-inline-flex align-items-center gap-2 ${
            isLiveWorkActive ? 'is-active' : ''
          }`}
          onClick={() => setIsThinkingDialogOpen(true)}
          aria-label="Show thinking events"
          title="Show thinking events"
        >
          <span
            className={`spinner-border spinner-border-sm ${isLiveWorkActive ? 'text-primary' : 'text-secondary'}`}
            aria-hidden="true"
          />
          <span className="small fw-semibold">{thinkingEvents.length}</span>
        </button>
      ) : null}

      <div className="position-fixed top-0 end-0 mt-5 me-3 d-flex flex-column align-items-end gap-2" style={{ zIndex: 1055 }}>
        <button
          type="button"
          className="btn btn-sm btn-light border shadow-sm d-inline-flex align-items-center gap-2 font-mono"
          onClick={() => setIsDebugPanelOpen((current) => !current)}
          aria-label={isDebugPanelOpen ? 'Hide debug panel' : 'Show debug panel'}
          title="Toggle debug panel (Ctrl/Cmd+Shift+D)"
        >
          <i className={`bi ${isDebugPanelOpen ? 'bi-bug-fill' : 'bi-bug'}`} aria-hidden="true" />
          <span>Debug</span>
        </button>

        {isDebugPanelOpen ? (
          <aside
            className="p-2 border rounded bg-light shadow-sm font-mono small"
            style={{ minWidth: '220px', opacity: 0.95 }}
            aria-label="Scroll debug panel"
          >
            <div className="d-flex align-items-center justify-content-between gap-2 mb-1">
              <div className="fw-semibold">Debug</div>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary py-0 px-1"
                onClick={() => setIsDebugPanelOpen(false)}
                aria-label="Close debug panel"
                title="Close debug panel"
              >
                <i className="bi bi-x-lg" aria-hidden="true" />
              </button>
            </div>
            <div>sentinelInView: {isSentinelInView ? 'yes' : 'no'}</div>
            <div>promptDockHeight: {Math.round(promptDockHeightPx)}px</div>
            <div>liveActive: {isLiveWorkActive ? 'yes' : 'no'}</div>
            <div className="text-secondary mt-1">Shortcut: Ctrl/Cmd+Shift+D</div>
          </aside>
        ) : null}
      </div>

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
