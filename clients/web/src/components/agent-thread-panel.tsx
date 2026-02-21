import React, { FormEvent } from 'react';
import { AgentEvent, ThreadState } from '../types';
import { roleForEvent } from '../thread-utils';

type AgentThreadPanelProps = {
  thread: ThreadState | null;
  conversationEvents: AgentEvent[];
  assistantTypingText?: string;
  conversationEndRef: React.RefObject<HTMLDivElement | null>;
  promptDockRef: React.RefObject<HTMLFormElement | null>;
  promptInputRef: React.RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onSubmitPrompt: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPromptChange: (value: string) => void;
};

export function AgentThreadPanel({
  thread,
  conversationEvents,
  assistantTypingText = '',
  conversationEndRef,
  promptDockRef,
  promptInputRef,
  prompt,
  onSubmitPrompt,
  onPromptKeyDown,
  onPromptChange,
}: AgentThreadPanelProps) {
  const visibleConversationEvents = conversationEvents.filter((event) => event.type !== 'turn.completed');

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
      {!thread ? <p className="text-secondary mb-0">No active thread yet.</p> : null}

      {thread ? (
        <>
          <div className="small mb-2">
            <strong>cwd:</strong> <code>{thread.cwd}</code>
          </div>
          <div className="small mb-2">
            <strong>thread:</strong> <code>{thread.threadId ?? 'unknown'}</code>
          </div>
          <ul className="list-group event-log chat-log">
            {visibleConversationEvents.length === 0 ? <li className="list-group-item text-secondary">No conversation yet.</li> : null}
            {visibleConversationEvents.map((agentEvent, index) => {
              const role = roleForEvent(agentEvent);
              return (
                <li key={agentEvent.seq} className="list-group-item border-0 bg-transparent p-0 mb-2">
                  <div className="turn-event-group rounded-3 border overflow-hidden">
                    <div
                      className={`ps-2 py-2 ${rowClassForRole(role)} ${index > 0 ? 'border-top' : ''} ${
                        role === 'user' ? 'border-bottom border-secondary-subtle' : ''
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
                  </div>
                </li>
              );
            })}
            {assistantTypingText.trim().length > 0 ? (
              <li className="list-group-item border-0 bg-transparent p-0 mb-2">
                <div className="turn-event-group typing-preview-box rounded-3 border overflow-hidden">
                  <div className="ps-2 py-2 list-group-item-light">
                    <div className="d-flex align-items-baseline">
                      <div className="flex-shrink-0 me-2">
                        <span
                          className="d-inline-flex align-items-center justify-content-center text-secondary"
                          style={{ width: '1.75rem', height: '1.75rem' }}
                          aria-hidden="true"
                        >
                          <i className="bi bi-robot typing-preview-icon" />
                        </span>
                      </div>
                      <div className="flex-grow-1">
                        <pre className="mb-0 chat-text">{assistantTypingText}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ) : null}
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
