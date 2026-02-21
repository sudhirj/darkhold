import React, { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { AgentEvent, ThreadState } from '../types';
import { isConversationEvent, isTransientProgressEvent, roleForEvent } from '../thread-utils';
import { jsonFetch, rpcPost, isThreadNotFoundError } from '../api';

function nowIso(): string {
  return new Date().toISOString();
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

type FileDiff = {
  path: string;
  diff: string;
};

type SummarizedItem = {
  type: string;
  message: string;
  fileDiffs?: FileDiff[];
};

function diffTextFromChange(change: any): string {
  const direct = [change?.diff, change?.patch, change?.unifiedDiff, change?.unified_diff, change?.content];
  for (const value of direct) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  const before = typeof change?.before === 'string' ? change.before : '';
  const after = typeof change?.after === 'string' ? change.after : '';
  if (before || after) {
    return `--- before\n+++ after\n${after}`;
  }

  try {
    return JSON.stringify(change, null, 2);
  } catch {
    return String(change);
  }
}

function normalizeFileDiffs(changes: any[]): FileDiff[] {
  return changes.map((change: any, index: number) => {
    const pathCandidates = [change?.path, change?.filePath, change?.file_path, change?.relativePath, change?.filename];
    let path = pathCandidates.find((value) => typeof value === 'string' && value.trim().length > 0) as string | undefined;
    if (!path) {
      path = `change-${index + 1}`;
    }
    return {
      path,
      diff: diffTextFromChange(change),
    };
  });
}

function summarizeThreadItem(item: any): SummarizedItem | null {
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
    const fileDiffs = normalizeFileDiffs(item.changes);
    return {
      type: 'file.change',
      message: `${item.changes.length} file(s) changed`,
      fileDiffs,
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

type AgentThreadPanelProps = {
  thread: ThreadState | null;
  onError: (message: string) => void;
  onTurnCompleted: () => void;
  onInteractionRequest: (payload: any) => void;
  showDebug?: boolean;
};

export function AgentThreadPanel({ thread, onError, onTurnCompleted, onInteractionRequest, showDebug = false }: AgentThreadPanelProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [latestEventSeq, setLatestEventSeq] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [assistantTypingText, setAssistantTypingText] = useState('');
  const [activeTurnIds, setActiveTurnIds] = useState<Set<string>>(new Set());
  const [isStickyScroll, setIsStickyScroll] = useState(true);
  const [fileDiffsBySeq, setFileDiffsBySeq] = useState<Record<number, FileDiff[]>>({});
  const [activeDiffSeq, setActiveDiffSeq] = useState<number | null>(null);
  const [activeDiffPath, setActiveDiffPath] = useState('');

  const latestTurnIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEventsSourceRef = useRef<EventSource | null>(null);
  const threadEventsSourceThreadIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const handleNotificationRef = useRef<(method: string, params: unknown) => void>(() => {});

  const threadId = thread?.threadId ?? null;

  const conversationEvents = useMemo(() => events.filter((event) => isConversationEvent(event)), [events]);
  const thinkingEvents = useMemo(() => events.filter((event) => isTransientProgressEvent(event)), [events]);
  const activityEvents = useMemo(() => thinkingEvents.filter((event) => event.type !== 'agent.delta'), [thinkingEvents]);
  const isLiveWorkActive = assistantTypingText.trim().length > 0;
  const isTurnActive = activeTurnIds.size > 0;

  // Reset all per-thread state when thread changes.
  useEffect(() => {
    const nextEvents = thread?.events ?? [];
    const nextSeq = thread?.latestEventSeq ?? 0;
    setEvents(nextEvents);
    setLatestEventSeq(nextSeq);
    seqRef.current = nextSeq;
    setPrompt('');
    setAssistantTypingText('');
    setActiveTurnIds(new Set());
    setFileDiffsBySeq({});
    setActiveDiffSeq(null);
    setActiveDiffPath('');
    latestTurnIdRef.current = null;
    shouldStickToBottomRef.current = true;
    setIsStickyScroll(true);
  }, [thread?.threadId]);

  // SSE connection — opens when threadId is set, closes on unmount or thread switch.
  useEffect(() => {
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
      handleNotificationRef.current(parsed.method, parsed.params);
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
  }, [threadId]);

  // Track whether the user is near the bottom of the page. Updates on every
  // scroll event (synchronous, no async observer race). Stickiness is disabled
  // only when the user actively scrolls away from the bottom.
  useEffect(() => {
    if (!thread) {
      shouldStickToBottomRef.current = true;
      return;
    }

    const onScroll = () => {
      const distanceFromBottom =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      const atBottom = distanceFromBottom < 40;
      shouldStickToBottomRef.current = atBottom;
      setIsStickyScroll(atBottom);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [thread?.id]);

  // Hard-snap to the document bottom when content/composer height changes, if sticky.
  // useLayoutEffect fires synchronously after React commits the DOM update but
  // before the browser paints, so the scroll position is corrected in the same
  // frame as the content change — no visible wobble.
  useLayoutEffect(() => {
    if (!thread || !shouldStickToBottomRef.current) {
      return;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, [thread?.id, latestEventSeq, prompt]);

  function snapToBottom() {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  // Focus prompt input when thread loads.
  useEffect(() => {
    if (!thread) {
      return;
    }
    promptInputRef.current?.focus();
  }, [thread?.id]);

  // Escape key handler for interrupt — only fires when focus is within this panel
  // so that multiple mounted panels don't all interrupt simultaneously.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !latestTurnIdRef.current) {
        return;
      }
      const panel = panelRef.current;
      const target = document.activeElement;
      if (!target || !panel?.contains(target)) {
        return;
      }
      event.preventDefault();
      void interruptTurn();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function pushEvent(type: string, message: string, turnId: string | null = null, fileDiffs: FileDiff[] = []) {
    seqRef.current += 1;
    const seq = seqRef.current;
    setEvents((current) => [...current, { seq, timestamp: nowIso(), type, message, turnId }]);
    if (fileDiffs.length > 0) {
      setFileDiffsBySeq((current) => ({ ...current, [seq]: fileDiffs }));
    }
    setLatestEventSeq(seq);
  }

  function clearActiveTurn(turnId: string) {
    setActiveTurnIds((prev) => {
      if (!prev.has(turnId)) return prev;
      const next = new Set(prev);
      next.delete(turnId);
      return next;
    });
    if (latestTurnIdRef.current === turnId) {
      latestTurnIdRef.current = null;
    }
  }

  function handleNotification(method: string, params: unknown) {
    const payload = (params ?? {}) as any;

    // Interaction requests bubble up to App's global dialog system.
    if (method === 'darkhold/interaction/request') {
      onInteractionRequest(payload);
      return;
    }

    // Track active turn IDs for interrupt support and activity bar visibility.
    const incomingTurnId = extractTurnId(payload);
    if (incomingTurnId) {
      latestTurnIdRef.current = incomingTurnId;
      setActiveTurnIds((prev) => {
        if (prev.has(incomingTurnId)) return prev;
        const next = new Set(prev);
        next.add(incomingTurnId);
        return next;
      });
    }

    if (method === 'turn/completed') {
      const completedTurnId = extractTurnId(payload);
      if (completedTurnId) {
        clearActiveTurn(completedTurnId);
      }
      setAssistantTypingText('');
      const turnStatus = typeof payload.turn?.status === 'string' ? payload.turn.status : '';
      if (turnStatus === 'failed' && payload.turn?.error?.message) {
        pushEvent('turn.error', payload.turn.error.message, extractTurnId(payload));
      }
      onTurnCompleted();
      return;
    }

    if ((method === 'item/started' || method === 'item/completed') && payload.item) {
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
      pushEvent(summary.type, summary.message, extractTurnId(payload), summary.fileDiffs ?? []);

      // Fallback: some streams may omit turn/completed for successful turns.
      // Treat terminal item completions as end-of-turn to avoid stuck activity state.
      if (method === 'item/completed' && incomingTurnId && (summary.type === 'file.change' || summary.type === 'assistant.output')) {
        clearActiveTurn(incomingTurnId);
        onTurnCompleted();
      }
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof payload.delta === 'string') {
      setAssistantTypingText((current) => current + payload.delta);
      pushEvent('agent.delta', payload.delta, extractTurnId(payload));
      return;
    }

    if (method === 'error' && payload?.message) {
      onError(String(payload.message));
    }
  }

  handleNotificationRef.current = handleNotification;

  async function interruptTurn() {
    const currentTurnId = latestTurnIdRef.current;
    if (!threadId || !currentTurnId) {
      return;
    }
    try {
      await rpcPost('turn/interrupt', { threadId, turnId: currentTurnId });
    } catch {
      // Turn may have already completed — ignore.
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || !prompt.trim()) {
      return;
    }

    const input = prompt.trim();
    const shouldPreserveBottom = shouldStickToBottomRef.current;

    try {
      setPrompt('');
      if (shouldPreserveBottom) {
        shouldStickToBottomRef.current = true;
        setIsStickyScroll(true);
        // Snap immediately for the composer height change, then once more next frame.
        snapToBottom();
        requestAnimationFrame(() => {
          snapToBottom();
        });
      }

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
      onError(message);
      pushEvent('turn.error', message);
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

  const visibleConversationEvents = conversationEvents.filter((event) => event.type !== 'turn.completed');
  const activeDiffFiles = activeDiffSeq ? (fileDiffsBySeq[activeDiffSeq] ?? []) : [];
  const activeDiff = activeDiffFiles.find((item) => item.path === activeDiffPath) ?? activeDiffFiles[0] ?? null;

  useEffect(() => {
    if (activeDiffFiles.length === 0) {
      if (activeDiffPath !== '') {
        setActiveDiffPath('');
      }
      return;
    }
    if (!activeDiffFiles.some((item) => item.path === activeDiffPath)) {
      setActiveDiffPath(activeDiffFiles[0].path);
    }
  }, [activeDiffFiles, activeDiffPath]);

  const rowClassForRole = (role: 'user' | 'assistant' | 'system') => {
    if (role === 'user') {
      return 'list-group-item-primary';
    }
    if (role === 'assistant') {
      return 'list-group-item-light';
    }
    return 'list-group-item-light';
  };

  return (
    <div ref={panelRef}>
      {!thread ? <p className="text-secondary mb-0">No active thread yet.</p> : null}

      {thread ? (
        <>
          <ul className="list-unstyled">
            {visibleConversationEvents.length === 0 ? <li className="text-secondary p-3">No conversation yet.</li> : null}
            {visibleConversationEvents.map((agentEvent) => {
              const role = roleForEvent(agentEvent);
              return (
                <li key={agentEvent.seq} className="mb-2">
                  <div className={`card border rounded-3 overflow-hidden bg-white bg-opacity-75 ${rowClassForRole(role)}`}>
                    <div className="card-body ps-2 py-2">
                      <div className="d-flex align-items-baseline">
                        <div className="flex-shrink-0 me-2 text-secondary opacity-50">
                          {role === 'user' ? <i className="bi bi-person-fill" /> : <i className="bi bi-robot" />}
                        </div>
                        <div className="flex-grow-1">
                          <pre className={`mb-0 chat-text ${role === 'user' ? 'fw-semibold opacity-75' : ''}`}>{agentEvent.message}</pre>
                          {agentEvent.type === 'file.change' && (fileDiffsBySeq[agentEvent.seq] ?? []).length > 0 ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary mt-2 d-inline-flex align-items-center gap-1"
                              onClick={() => {
                                setActiveDiffSeq(agentEvent.seq);
                                setActiveDiffPath((fileDiffsBySeq[agentEvent.seq] ?? [])[0]?.path ?? '');
                              }}
                            >
                              <i className="bi bi-file-diff" aria-hidden="true" />
                              <span>View Diff</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
            {assistantTypingText.trim().length > 0 ? (
              <li className="mb-2">
                <div className="card border rounded-3 overflow-hidden bg-white bg-opacity-75 typing-preview-box">
                  <div className="card-body ps-2 py-2 list-group-item-light">
                    <div className="d-flex align-items-baseline">
                      <div className="flex-shrink-0 me-2 text-secondary opacity-50">
                        <i className="bi bi-robot typing-preview-icon" />
                      </div>
                      <div className="flex-grow-1">
                        <pre className="mb-0 chat-text">{assistantTypingText}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ) : null}
          </ul>

          <form
            className="border-top py-2 mt-3"
            onSubmit={(event) => void submitPrompt(event)}
          >
            {isTurnActive ? (
              <div className="pb-2">
                <div className="d-flex align-items-center justify-content-between gap-2 small">
                  <div className="d-flex align-items-center gap-2 min-w-0">
                    <span
                      className={`spinner-border spinner-border-sm flex-shrink-0 ${isLiveWorkActive ? 'text-primary' : 'text-secondary'}`}
                      aria-hidden="true"
                    />
                    {activityEvents.length > 0 ? (
                      <span className="text-truncate text-secondary font-mono">
                        <span className="badge bg-secondary-subtle text-secondary-emphasis me-1">
                          {activityEvents[activityEvents.length - 1].type}
                        </span>
                        {activityEvents[activityEvents.length - 1].message}
                      </span>
                    ) : (
                      <span className="text-secondary">Working...</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger flex-shrink-0 d-inline-flex align-items-center gap-1"
                    onClick={() => void interruptTurn()}
                    aria-label="Stop current turn"
                    title="Stop current turn (Escape)"
                  >
                    <i className="bi bi-stop-circle" aria-hidden="true" />
                    <span>Stop</span>
                  </button>
                </div>
              </div>
            ) : null}
            <textarea
              ref={promptInputRef}
              className="form-control"
              rows={3}
              placeholder="Ask Codex to inspect, edit, or explain this folder..."
              value={prompt}
              onKeyDown={handlePromptKeyDown}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </form>

        </>
      ) : null}

      {showDebug && thread ? (
        <aside
          className="position-fixed bottom-0 end-0 mb-3 me-3 p-2 border rounded bg-light shadow-sm font-mono small"
          style={{ minWidth: '180px', opacity: 0.95, zIndex: 1055 }}
          aria-label="Thread debug panel"
        >
          <div className="fw-semibold mb-1">Thread Debug</div>
          <div>stickyScroll: {isStickyScroll ? 'yes' : 'no'}</div>
          <div>events: {events.length}</div>
          <div>activeTurns: {activeTurnIds.size}</div>
          <div>liveWork: {isLiveWorkActive ? 'yes' : 'no'}</div>
        </aside>
      ) : null}

      {activeDiffSeq ? (
        <Dialog open onClose={() => setActiveDiffSeq(null)} className="position-relative">
          <DialogBackdrop className="modal-backdrop fade show" />
          <div className="modal fade show d-block position-fixed top-0 start-0 w-100 h-100" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-scrollable modal-xl modal-dialog-centered">
              <DialogPanel className="modal-content">
                <div className="modal-header">
                  <DialogTitle as="h2" className="modal-title h5 mb-0">
                    File Changes
                  </DialogTitle>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setActiveDiffSeq(null)} />
                </div>
                <div className="modal-body">
                  {activeDiffFiles.length > 1 ? (
                    <div className="mb-3">
                      <label htmlFor="diff-file-select" className="form-label small text-secondary">
                        File
                      </label>
                      <select
                        id="diff-file-select"
                        className="form-select form-select-sm font-mono"
                        value={activeDiffPath}
                        onChange={(event) => setActiveDiffPath(event.target.value)}
                      >
                        {activeDiffFiles.map((item) => (
                          <option key={item.path} value={item.path}>
                            {item.path}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {activeDiff ? (
                    <>
                      <div className="small text-secondary font-mono mb-2">{activeDiff.path}</div>
                      <pre className="mb-0 chat-text">{activeDiff.diff}</pre>
                    </>
                  ) : (
                    <p className="text-secondary mb-0">No diff details available.</p>
                  )}
                </div>
              </DialogPanel>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
