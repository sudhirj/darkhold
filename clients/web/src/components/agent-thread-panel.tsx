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
            <li aria-hidden="true">
              <div className="event-log-bottom-spacer" />
            </li>
            <li aria-hidden="true">
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
