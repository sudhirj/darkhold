import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsonFetch } from './api';
import { FolderBrowserDialog } from './components/folder-browser-dialog';
import { AgentThreadPanel } from './components/agent-thread-panel';
import { isConversationEvent, isTransientProgressEvent } from './session-utils';
import { FolderEntry, FolderListing, Session } from './types';

function App() {
  const [folderCache, setFolderCache] = useState<Record<string, FolderListing>>({});
  const [columnPaths, setColumnPaths] = useState<string[]>([]);
  const [columnSearch, setColumnSearch] = useState<Record<string, string>>({});
  const [columnSelections, setColumnSelections] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const folderInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const suppressNextAutoFocusRef = useRef(false);
  const [pendingFocusPath, setPendingFocusPath] = useState<string | null>(null);
  const activeSessionId = session?.id ?? '';

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
      setIsFolderBrowserOpen(false);
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

  function openFolderBrowser() {
    setPendingFocusPath(null);
    void initializeFolderBrowser();
    setIsFolderBrowserOpen(true);
  }

  return (
    <>
      <nav className="navbar bg-body-tertiary border-bottom">
        <div className="container">
          <span className="navbar-brand mb-0 h1">Darkhold Agent Host</span>
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

      <main className="container py-4">
        {error ? <div className="alert alert-danger">{error}</div> : null}
        <div className="row g-3">
          <AgentThreadPanel
            session={session}
            sessions={sessions}
            activeSessionId={activeSessionId}
            conversationEvents={conversationEvents}
            transientProgressEvents={transientProgressEvents}
            conversationEndRef={conversationEndRef}
            promptInputRef={promptInputRef}
            prompt={prompt}
            onResumeSession={resumeSession}
            onSubmitPrompt={submitPrompt}
            onPromptKeyDown={handlePromptKeyDown}
            onPromptChange={setPrompt}
          />
        </div>
      </main>
    </>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing root element.');
}

createRoot(root).render(<App />);
