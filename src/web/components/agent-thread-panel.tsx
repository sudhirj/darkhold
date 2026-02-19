import React, { FormEvent } from 'react';
import { AgentEvent, Session } from '../types';
import { roleForEvent } from '../session-utils';

type AgentThreadPanelProps = {
  session: Session | null;
  conversationEvents: AgentEvent[];
  transientProgressEvents: AgentEvent[];
  conversationEndRef: React.RefObject<HTMLDivElement | null>;
  promptInputRef: React.RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onSubmitPrompt: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptChange: (value: string) => void;
};

export function AgentThreadPanel({
  session,
  conversationEvents,
  transientProgressEvents,
  conversationEndRef,
  promptInputRef,
  prompt,
  onSubmitPrompt,
  onPromptKeyDown,
  onPromptChange,
}: AgentThreadPanelProps) {
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
    <>
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
            {conversationEvents.map((agentEvent) => {
              const role = roleForEvent(agentEvent);
              return (
                <li key={agentEvent.seq} className={`list-group-item ps-2 ${rowClassForRole(role)}`}>
                  <div className="d-flex align-items-baseline">
                    <div className="flex-shrink-0 me-2">
                      <span
                        className="d-inline-flex align-items-center justify-content-center rounded-circle bg-body border text-secondary"
                        style={{ width: '1.75rem', height: '1.75rem' }}
                        aria-hidden="true"
                      >
                        {role === 'user' ? <i className="bi bi-person-fill" /> : <i className="bi bi-robot" />}
                      </span>
                    </div>
                    <div className="flex-grow-1">
                      <pre className="mb-0 chat-text">{agentEvent.message}</pre>
                    </div>
                  </div>
                </li>
              );
            })}
            <li className="list-group-item border-0 p-0" aria-hidden="true">
              <div ref={conversationEndRef} />
            </li>
          </ul>

          <form
            className="position-fixed bottom-0 start-0 end-0 bg-body-tertiary border-top py-2"
            onSubmit={(event) => void onSubmitPrompt(event)}
          >
            <div className="container-fluid px-3 pb-2">
              <textarea
                id="prompt"
                ref={promptInputRef}
                className="form-control"
                rows={3}
                placeholder="Ask Codex to inspect, edit, or explain this folder..."
                value={prompt}
                onKeyDown={onPromptKeyDown}
                onChange={(event) => onPromptChange(event.target.value)}
              />
            </div>
          </form>
        </>
      ) : null}
    </>
  );
}
