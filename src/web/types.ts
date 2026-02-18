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
};

export type SessionStatus = 'idle' | 'running' | 'error';

export type Session = {
  id: string;
  cwd: string;
  status: SessionStatus;
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
