import React, { FormEvent } from 'react';
import { AgentEvent, Session } from '../types';
import { roleForEvent } from '../session-utils';

type AgentThreadPanelProps = {
  session: Session | null;
  conversationEvents: AgentEvent[];
  conversationEndRef: React.RefObject<HTMLDivElement | null>;
  promptDockRef: React.RefObject<HTMLFormElement | null>;
  promptInputRef: React.RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onSubmitPrompt: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptChange: (value: string) => void;
};

export function AgentThreadPanel({
  session,
  conversationEvents,
  conversationEndRef,
  promptDockRef,
  promptInputRef,
  prompt,
  onSubmitPrompt,
  onPromptKeyDown,
  onPromptChange,
}: AgentThreadPanelProps) {
  const visibleConversationEvents = conversationEvents.filter((event) => event.type !== 'turn.completed');

  const turnGroups = visibleConversationEvents.reduce<Array<{ key: string; events: AgentEvent[] }>>((groups, event) => {
    const groupKey = event.turnId ?? `no-turn:${event.seq}`;
    const current = groups[groups.length - 1];
    if (!current || current.key !== groupKey) {
      groups.push({ key: groupKey, events: [event] });
      return groups;
    }
    current.events.push(event);
    return groups;
  }, []);

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

          <ul className="list-group event-log chat-log">
            {visibleConversationEvents.length === 0 ? <li className="list-group-item text-secondary">No conversation yet.</li> : null}
            {turnGroups.map((group) => (
              <li key={group.key} className="list-group-item border-0 bg-transparent p-0 mb-2">
                <div className="turn-event-group rounded-3 border overflow-hidden">
                  {group.events.map((agentEvent, index) => {
                    const role = roleForEvent(agentEvent);
                    return (
                      <div
                        key={agentEvent.seq}
                        className={`ps-2 py-2 ${rowClassForRole(role)} ${index > 0 ? 'border-top' : ''} ${
                          role === 'user' ? 'user-message-row' : ''
                        }`}
                      >
                        <div className="d-flex align-items-baseline">
                          <div className="flex-shrink-0 me-2">
                            <span
                              className="d-inline-flex align-items-center justify-content-center text-secondary"
                              style={{ width: '1.75rem', height: '1.75rem' }}
                              aria-hidden="true"
                            >
                              {role === 'user' ? <i className="bi bi-person-fill" style={{ opacity: 0.6 }} /> : <i className="bi bi-robot" style={{ opacity: 0.6 }} />}
                            </span>
                          </div>
                          <div className="flex-grow-1">
                            <pre className={`mb-0 chat-text ${role === 'user' ? 'user-message-text' : ''}`}>{agentEvent.message}</pre>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
            <li className="list-group-item border-0 bg-transparent p-0" aria-hidden="true">
              <div className="event-log-bottom-spacer" />
            </li>
            <li className="list-group-item border-0 bg-transparent p-0" aria-hidden="true">
              <div ref={conversationEndRef} className="event-log-bottom-sentinel" />
            </li>
          </ul>

          <form
            ref={promptDockRef}
            className="position-fixed bottom-0 start-0 end-0 bg-body-tertiary border-top py-2 prompt-dock"
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
