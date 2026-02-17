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

function App() {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDir, setSelectedDir] = useState<FolderEntry | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [prompt, setPrompt] = useState('');

  const directories = useMemo(
    () => (listing?.entries ?? []).filter((entry) => entry.kind === 'directory'),
    [listing],
  );

  useEffect(() => {
    void refreshFolder();
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
    if (!session) {
      return;
    }

    const timer = setInterval(() => {
      void pollSession(session.id);
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
