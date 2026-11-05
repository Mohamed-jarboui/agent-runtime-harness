import type { MemoryRecord, MemorySearchHit } from './store.js';

export interface MemoryStoreInput {
  content: string;
  tags?: string[];
  scope?: 'session' | 'global';
  sessionId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  source?: string;
}

export interface MemorySearchOptions {
  sessionId?: string | null;
  scope?: 'session' | 'global' | 'all';
  limit?: number;
}

/** Long-term memory contract used by tools and the context builder. */
export interface MemoryService {
  store(input: MemoryStoreInput): MemoryRecord;
  search(query: string, options?: MemorySearchOptions): MemorySearchHit[];
}
