import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import {
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
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDir, setSelectedDir] = useState<FolderEntry | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [prompt, setPrompt] = useState('');

  const directories = useMemo(
    () => (listing?.entries ?? []).filter((entry) => entry.kind === 'directory'),
    [listing],
  );

  useEffect(() => {
    void refreshFolder();
    void refreshSessions();
  }, []);

  useEffect(() => {
    if (!listing) {
      return;
    }

    if (selectedDir && directories.some((dir) => dir.path === selectedDir.path)) {
      return;
    }

    setSelectedDir(directories[0] ?? null);
  }, [listing?.path, directories.length]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (session) {
        void pollSession(session.id);
      }
      void refreshSessions();
    }, 1000);

    return () => clearInterval(timer);
  }, [session?.id]);

  async function refreshFolder(path?: string) {
    try {
      setError(null);
      const next = await jsonFetch<FolderListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      setListing(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openSelectedFolder() {
    if (!selectedDir) {
      return;
    }
    await refreshFolder(selectedDir.path);
  }

  async function enterDirectory(targetPath: string) {
    await refreshFolder(targetPath);
  }

  async function startSession() {
    const targetPath = selectedDir?.path ?? listing?.path;
    if (!targetPath) {
      return;
    }

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
              <p className="font-mono small border rounded p-2">{listing?.path ?? 'Loading...'}</p>

              {listing ? (
                <div className="d-flex flex-wrap gap-1 mb-3">
                  {pathSegments(listing.root, listing.path).map((segment) => (
                    <button
                      key={segment.path}
                      className="btn btn-sm btn-outline-secondary"
                      type="button"
                      onClick={() => void refreshFolder(segment.path)}
                    >
                      {segment.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="d-flex gap-2 mb-3">
                <button
                  className="btn btn-outline-secondary btn-sm"
                  type="button"
                  onClick={() => void refreshFolder(listing?.parent ?? undefined)}
                  disabled={!listing?.parent}
                >
                  Up
                </button>
                <button
                  className="btn btn-outline-primary btn-sm"
                  type="button"
                  onClick={() => void openSelectedFolder()}
                  disabled={!selectedDir}
                >
                  Open Selected
                </button>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => void startSession()}>
                  Start Agent
                </button>
              </div>

              <label className="form-label">Directory</label>
              <Listbox value={selectedDir} onChange={setSelectedDir}>
                <div className="position-relative">
                  <ListboxButton className="btn btn-light border w-100 text-start">
                    {selectedDir ? selectedDir.name : 'No directories found'}
                  </ListboxButton>
                  <ListboxOptions className="position-absolute mt-1 w-100 border rounded bg-white shadow-sm p-1 folder-list z-3">
                    {directories.map((dir) => (
                      <ListboxOption
                        key={dir.path}
                        value={dir}
                        className="list-group-item list-group-item-action border-0 rounded"
                      >
                        {dir.name}
                      </ListboxOption>
                    ))}
                  </ListboxOptions>
                </div>
              </Listbox>

              <div className="mt-3">
                <p className="small text-secondary mb-2">Drill into folders</p>
                <ul className="list-group folder-list">
                  {listing?.parent ? (
                    <li className="list-group-item p-2">
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        type="button"
                        onClick={() => void refreshFolder(listing.parent ?? undefined)}
                      >
                        .. (up)
                      </button>
                    </li>
                  ) : null}
                  {directories.map((dir) => (
                    <li key={dir.path} className="list-group-item d-flex justify-content-between align-items-center gap-2">
                      <button
                        className="btn btn-link text-decoration-none p-0 text-start"
                        type="button"
                        onClick={() => void setSelectedDir(dir)}
                      >
                        {dir.name}
                      </button>
                      <button
                        className="btn btn-sm btn-outline-primary"
                        type="button"
                        onClick={() => void enterDirectory(dir.path)}
                      >
                        Enter
                      </button>
                    </li>
                  ))}
                  {directories.length === 0 ? (
                    <li className="list-group-item text-secondary">No directories in this folder.</li>
                  ) : null}
                </ul>
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
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <h2 className="h6 mb-0">Active Sessions</h2>
                  <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => void refreshSessions()}>
                    Refresh
                  </button>
                </div>
                <ul className="list-group mb-3">
                  {sessions.length === 0 ? (
                    <li className="list-group-item text-secondary">No active sessions.</li>
                  ) : null}
                  {sessions.map((item) => (
                    <li key={item.id} className="list-group-item d-flex justify-content-between align-items-center gap-2">
                      <div>
                        <div className="small font-mono">{item.id.slice(0, 8)}</div>
                        <div className="small text-secondary text-break">{item.cwd}</div>
                      </div>
                      <div className="d-flex align-items-center gap-2">
                        <span className={`badge ${statusClass(item.status)}`}>{item.status}</span>
                        <button
                          className="btn btn-sm btn-outline-primary"
                          type="button"
                          onClick={() => void resumeSession(item.id)}
                        >
                          Resume
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
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

                  <ul className="list-group event-log mb-3">
                    {session.events.length === 0 ? (
                      <li className="list-group-item text-secondary">No events yet.</li>
                    ) : null}
                    {session.events.map((agentEvent) => (
                      <li key={agentEvent.seq} className="list-group-item">
                        <div className="small text-secondary mb-1 font-mono">#{agentEvent.seq} {agentEvent.type}</div>
                        <div>{agentEvent.message}</div>
                      </li>
                    ))}
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
