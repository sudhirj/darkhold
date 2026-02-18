import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react';
import { createRoot } from 'react-dom/client';

type FolderEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
};

type FolderListing = {
  root: string;
  path: string;
  parent: string | null;
  entries: FolderEntry[];
};

type AgentEvent = {
  seq: number;
  timestamp: string;
  type: string;
  message: string;
};

type Session = {
  id: string;
  cwd: string;
  status: 'idle' | 'running' | 'error';
  createdAt: string;
  updatedAt: string;
  threadId: string | null;
  latestEventSeq: number;
  progress: {
    completedItems: number;
    lastEventType: string | null;
  };
  events: AgentEvent[];
};

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

function statusClass(status: Session['status']): string {
  if (status === 'running') {
    return 'text-bg-success';
  }
  if (status === 'error') {
    return 'text-bg-danger';
  }
  return 'text-bg-secondary';
}

function roleForEvent(event: AgentEvent): 'user' | 'assistant' | 'system' {
  if (event.type === 'user.input') {
    return 'user';
  }
  if (event.type === 'item.completed') {
    return 'assistant';
  }
  return 'system';
}

function isConversationEvent(event: AgentEvent): boolean {
  if (event.type === 'user.input') {
    return true;
  }
  if (event.type === 'item.completed') {
    return event.message.trim().length > 0;
  }
  if (event.type === 'turn.error') {
    return true;
  }
  return false;
}

function isTransientProgressEvent(event: AgentEvent): boolean {
  return !isConversationEvent(event) && event.type !== 'session.created' && event.type !== 'turn.completed';
}

function pathSegments(root: string, currentPath: string): Array<{ label: string; path: string }> {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  const normalizedCurrent = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
  const relative = normalizedCurrent.slice(normalizedRoot.length).replace(/^\/+/, '');
  const segments = relative.length === 0 ? [] : relative.split('/');
  const breadcrumb = [{ label: '~', path: normalizedRoot }];

  let runningPath = normalizedRoot;
  for (const segment of segments) {
    runningPath = `${runningPath}/${segment}`;
    breadcrumb.push({ label: segment, path: runningPath });
  }

  return breadcrumb;
}

function App() {
  const [folderCache, setFolderCache] = useState<Record<string, FolderListing>>({});
  const [columnPaths, setColumnPaths] = useState<string[]>([]);
  const [columnSearch, setColumnSearch] = useState<Record<string, string>>({});
  const [columnSelections, setColumnSelections] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [prompt, setPrompt] = useState('');
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const folderInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const suppressNextAutoFocusRef = useRef(false);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const activeSessionId = session?.id ?? '';

  const currentPath = columnPaths.length > 0 ? columnPaths[columnPaths.length - 1] : null;
  const currentListing = currentPath ? folderCache[currentPath] ?? null : null;

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
    void refreshSessions();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (session) {
        void pollSession(session.id);
      }
      void refreshSessions();
    }, 1000);

    return () => clearInterval(timer);
  }, [session?.id]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end' });
  }, [session?.latestEventSeq]);

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

  function directoriesFor(listingPath: string): FolderEntry[] {
    const listing = folderCache[listingPath];
    if (!listing) {
      return [];
    }
    return listing.entries.filter((entry) => entry.kind === 'directory');
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

  function filterDirectories(listingPath: string): FolderEntry[] {
    const searchValue = columnSearch[listingPath]?.trim().toLowerCase() ?? '';
    const dirs = directoriesFor(listingPath);
    if (!searchValue) {
      return dirs;
    }
    return dirs.filter((entry) => entry.name.toLowerCase().includes(searchValue));
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

  async function startSessionForPath(targetPath: string) {
    try {
      setError(null);
      const payload = await jsonFetch<{ session: Session }>('/api/agents/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: targetPath }),
      });
      setSession(payload.session);
      await refreshSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshSessions() {
    try {
      const payload = await jsonFetch<{ sessions: Session[] }>('/api/agents');
      setSessions(payload.sessions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resumeSession(sessionId: string) {
    await pollSession(sessionId);
  }

  async function pollSession(sessionId: string) {
    try {
      const current = await jsonFetch<{ session: Session }>(`/api/agents/${sessionId}`);
      setSession(current.session);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !prompt.trim()) {
      return;
    }

    try {
      setError(null);
      await jsonFetch(`/api/agents/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: prompt }),
      });
      setPrompt('');
      await pollSession(session.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <main className="container py-4">
      <div className="mb-4">
        <h1 className="display-6 mb-1">Darkhold Agent Host</h1>
        <p className="text-secondary mb-0">
          Browse your home directory, launch a Codex thread for a folder, and stream progress.
        </p>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="row g-3">
        <section className="col-12 col-lg-5">
          <div className="card shadow-sm">
            <div className="card-header">Folder Browser</div>
            <div className="card-body">
              <p className="small text-secondary mb-2">Current path</p>
              <p className="font-mono small border rounded p-2">{currentPath ?? 'Loading...'}</p>

              {currentListing ? (
                <div className="d-flex flex-wrap gap-1 mb-3">
                  {pathSegments(currentListing.root, currentListing.path).map((segment) => (
                    <button
                      key={segment.path}
                      className="btn btn-sm btn-outline-secondary"
                      type="button"
                      onClick={() => {
                        const segmentIndex = columnPaths.findIndex((path) => path === segment.path);
                        if (segmentIndex >= 0) {
                          setColumnPaths((prev) => prev.slice(0, segmentIndex + 1));
                        }
                      }}
                    >
                      {segment.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="d-flex flex-column gap-2">
                {columnPaths.map((listingPath, columnIndex) => {
                  const listing = folderCache[listingPath];
                  const directories = filterDirectories(listingPath);
                  const allDirectories = directoriesFor(listingPath);
                  const selectedPath = columnSelections[listingPath] ?? null;
                  const selectedDirName =
                    allDirectories.find((entry) => entry.path === selectedPath)?.name ?? null;
                  const searchId = `folder-search-${columnIndex}`;

                  return (
                    <section key={listingPath} className="w-100">
                      <div className="d-flex gap-2 align-items-start">
                        <div className="flex-grow-1">
                          <Combobox
                            immediate
                            value={selectedPath}
                            onChange={(nextPath) => {
                              if (nextPath) {
                                void onSelectDirectory(columnIndex, listingPath, nextPath);
                              }
                            }}
                            disabled={!listing || allDirectories.length === 0}
                          >
                            <div className="position-relative">
                              <ComboboxInput
                                id={searchId}
                                ref={(node) => {
                                  folderInputRefs.current[listingPath] = node;
                                }}
                                className="form-control form-control-sm"
                                aria-label={`Search folders in combobox ${columnIndex + 1}`}
                                placeholder={listing ? 'Type to search folders' : 'Loading folders...'}
                                displayValue={(value: string | null) =>
                                  directoriesFor(listingPath).find((entry) => entry.path === value)?.name ?? ''
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Tab') {
                                    suppressNextAutoFocusRef.current = true;
                                  } else if (event.key === 'Enter') {
                                    suppressNextAutoFocusRef.current = false;
                                  }
                                }}
                                onChange={(event) =>
                                  setColumnSearch((prev) => ({
                                    ...prev,
                                    [listingPath]: event.target.value,
                                  }))
                                }
                              />
                              <ComboboxOptions className="position-absolute mt-1 w-100 border rounded bg-white shadow-sm p-1 z-3 folder-list">
                                {listing && directories.map((dir) => (
                                  <ComboboxOption
                                    key={dir.path}
                                    value={dir.path}
                                    className={({ focus, selected }) =>
                                      `list-group-item border-0 rounded px-2 py-2 d-flex justify-content-between align-items-center ${
                                        selected
                                          ? 'active'
                                          : focus
                                            ? 'list-group-item-primary'
                                            : 'list-group-item-action'
                                      }`
                                    }
                                  >
                                    <span>{dir.name}</span>
                                    {selectedPath === dir.path ? <i className="bi bi-check2" aria-hidden="true" /> : null}
                                  </ComboboxOption>
                                ))}
                                {listing && directories.length === 0 ? (
                                  <div className="list-group-item text-secondary border-0 rounded px-2 py-2">
                                    No matching folders.
                                  </div>
                                ) : null}
                              </ComboboxOptions>
                            </div>
                          </Combobox>
                        </div>
                        <Button
                          as="button"
                          type="button"
                          tabIndex={0}
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => void startSessionForPath(listingPath)}
                          disabled={!listing}
                          aria-label={`Open agent for combobox ${columnIndex + 1}`}
                          title="Open agent"
                        >
                          <i className="bi bi-robot" aria-hidden="true" />
                        </Button>
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="col-12 col-lg-7">
          <div className="card shadow-sm">
            <div className="card-header d-flex justify-content-between align-items-center">
              <span>Agent Thread</span>
              {session ? <span className={`badge ${statusClass(session.status)}`}>{session.status}</span> : null}
            </div>
            <div className="card-body">
              <div className="mb-3">
                <h2 className="h6 mb-2">Active Sessions</h2>
                {sessions.length === 0 ? <div className="text-secondary small mb-3">No active sessions.</div> : null}
                {sessions.length > 0 ? (
                  <Listbox
                    value={activeSessionId}
                    onChange={(nextSessionId) => {
                      if (nextSessionId) {
                        void resumeSession(nextSessionId);
                      }
                    }}
                  >
                    <div className="position-relative mb-3">
                      <ListboxButton className="btn btn-light border w-100 text-start d-flex justify-content-between align-items-center gap-2">
                        <span className="text-truncate">
                          {session ? `${session.id.slice(0, 8)} · ${session.cwd}` : 'Select a session'}
                        </span>
                        {session ? <span className={`badge ${statusClass(session.status)}`}>{session.status}</span> : null}
                      </ListboxButton>
                      <ListboxOptions className="position-absolute mt-1 w-100 border rounded bg-white shadow-sm p-1 z-3 folder-list">
                        {sessions.map((item) => (
                          <ListboxOption
                            key={item.id}
                            value={item.id}
                            className="list-group-item list-group-item-action border-0 rounded"
                          >
                            <div className="d-flex justify-content-between align-items-center gap-2">
                              <div className="text-start">
                                <div className="small font-mono">{item.id.slice(0, 8)}</div>
                                <div className="small text-secondary text-break">{item.cwd}</div>
                              </div>
                              <span className={`badge ${statusClass(item.status)}`}>{item.status}</span>
                            </div>
                          </ListboxOption>
                        ))}
                      </ListboxOptions>
                    </div>
                  </Listbox>
                ) : null}
              </div>

              {!session ? <p className="text-secondary mb-0">No active session yet.</p> : null}

              {session ? (
                <>
                  <div className="small mb-2">
                    <strong>cwd:</strong> <code>{session.cwd}</code>
                  </div>
                  <div className="small mb-2">
                    <strong>thread:</strong> <code>{session.threadId ?? 'unknown'}</code>
                  </div>
                  <div className="small mb-3">
                    <strong>progress:</strong> {session.progress.completedItems} items complete
                    {session.progress.lastEventType ? `, last event ${session.progress.lastEventType}` : ''}
                  </div>

                  {transientProgressEvents.length > 0 ? (
                    <div className="alert alert-info py-2 mb-3" role="status">
                      <div className="small fw-semibold mb-1">Live progress</div>
                      <ul className="mb-0 ps-3">
                        {transientProgressEvents.map((agentEvent) => (
                          <li key={agentEvent.seq} className="small">
                            <span className="font-mono text-secondary me-1">{agentEvent.type}</span>
                            {agentEvent.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <ul className="list-group event-log mb-3 chat-log">
                    {conversationEvents.length === 0 ? (
                      <li className="list-group-item text-secondary">No conversation yet.</li>
                    ) : null}
                    {conversationEvents.map((agentEvent) => (
                      <li key={agentEvent.seq} className={`list-group-item chat-item chat-item-${roleForEvent(agentEvent)}`}>
                        <div className="d-flex justify-content-between gap-2 mb-1">
                          <span className="small fw-semibold text-capitalize">{roleForEvent(agentEvent)}</span>
                          <span className="small text-secondary font-mono">#{agentEvent.seq}</span>
                        </div>
                        <pre className="mb-0 chat-text">{agentEvent.message}</pre>
                      </li>
                    ))}
                    <li className="list-group-item border-0 p-0" aria-hidden="true">
                      <div ref={conversationEndRef} />
                    </li>
                  </ul>

                  <form onSubmit={(event) => void submitPrompt(event)}>
                    <label htmlFor="prompt" className="form-label">
                      Input
                    </label>
                    <textarea
                      id="prompt"
                      className="form-control mb-2"
                      rows={5}
                      placeholder="Ask Codex to inspect, edit, or explain this folder..."
                      value={prompt}
                      onKeyDown={handlePromptKeyDown}
                      onChange={(event) => setPrompt(event.target.value)}
                    />
                    <button className="btn btn-primary" type="submit" disabled={session.status === 'running'}>
                      Send
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing root element.');
}

createRoot(root).render(<App />);
