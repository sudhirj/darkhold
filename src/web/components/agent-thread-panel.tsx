import React, { FormEvent } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { AgentEvent, Session } from '../types';
import { roleForEvent, statusClass } from '../session-utils';

type AgentThreadPanelProps = {
  session: Session | null;
  sessions: Session[];
  activeSessionId: string;
  conversationEvents: AgentEvent[];
  transientProgressEvents: AgentEvent[];
  conversationEndRef: React.RefObject<HTMLDivElement | null>;
  promptInputRef: React.RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onResumeSession: (sessionId: string) => Promise<void>;
  onSubmitPrompt: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptChange: (value: string) => void;
};

export function AgentThreadPanel({
  session,
  sessions,
  activeSessionId,
  conversationEvents,
  transientProgressEvents,
  conversationEndRef,
  promptInputRef,
  prompt,
  onResumeSession,
  onSubmitPrompt,
  onPromptKeyDown,
  onPromptChange,
}: AgentThreadPanelProps) {
  return (
    <section className="col-12">
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
                    void onResumeSession(nextSessionId);
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
                {conversationEvents.length === 0 ? <li className="list-group-item text-secondary">No conversation yet.</li> : null}
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

              <form onSubmit={(event) => void onSubmitPrompt(event)}>
                <label htmlFor="prompt" className="form-label">
                  Input
                </label>
                <textarea
                  id="prompt"
                  ref={promptInputRef}
                  className="form-control mb-2"
                  rows={3}
                  placeholder="Ask Codex to inspect, edit, or explain this folder..."
                  value={prompt}
                  onKeyDown={onPromptKeyDown}
                  onChange={(event) => onPromptChange(event.target.value)}
                />
              </form>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
