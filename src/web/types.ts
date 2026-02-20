export type FolderEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
};

export type FolderListing = {
  root: string;
  path: string;
  parent: string | null;
  entries: FolderEntry[];
};

export type AgentEvent = {
  seq: number;
  timestamp: string;
  type: string;
  message: string;
  turnId: string | null;
};

export type SessionStatus = 'idle' | 'running' | 'error';

export type Session = {
  id: string;
  cwd: string;
  status: SessionStatus;
  updatedAt: string;
  threadId: string;
  currentTurnId: string | null;
  latestEventSeq: number;
  progress: {
    completedItems: number;
    lastEventType: string | null;
  };
  events: AgentEvent[];
};

export type SessionSummary = {
  id: string;
  cwd: string;
  status: SessionStatus;
  updatedAt: string;
};
