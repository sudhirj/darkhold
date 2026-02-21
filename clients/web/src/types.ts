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

export type ThreadState = {
  id: string;
  cwd: string;
  updatedAt: string;
  threadId: string;
  latestEventSeq: number;
  events: AgentEvent[];
};

export type ThreadSummary = {
  id: string;
  cwd: string;
  updatedAt: string;
};
