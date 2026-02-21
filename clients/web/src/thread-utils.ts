import { AgentEvent } from './types';

export function roleForEvent(event: AgentEvent): 'user' | 'assistant' | 'system' {
  if (event.type === 'user.input') {
    return 'user';
  }
  if (event.type === 'assistant.output') {
    return 'assistant';
  }
  return 'system';
}

export function isConversationEvent(event: AgentEvent): boolean {
  if (event.type === 'user.input') {
    return true;
  }
  if (event.type === 'assistant.output') {
    return event.message.trim().length > 0;
  }
  if (event.type === 'turn.completed') {
    return true;
  }
  if (event.type === 'turn.error') {
    return true;
  }
  return false;
}

export function isTransientProgressEvent(event: AgentEvent): boolean {
  // Policy reference: docs/architecture.md ("Transient Event Policy").
  return !isConversationEvent(event) && event.type !== 'thread.created' && event.type !== 'turn.completed';
}
