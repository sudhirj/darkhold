import { AgentEvent, SessionStatus } from './types';

export function roleForEvent(event: AgentEvent): 'user' | 'assistant' | 'system' {
  if (event.type === 'user.input') {
    return 'user';
  }
  if (event.type === 'item.completed') {
    return 'assistant';
  }
  return 'system';
}

export function isConversationEvent(event: AgentEvent): boolean {
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

export function isTransientProgressEvent(event: AgentEvent): boolean {
  return !isConversationEvent(event) && event.type !== 'session.created' && event.type !== 'turn.completed';
}
