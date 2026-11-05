import {
  LoopSmithError,
  type MemoryRecord,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryService,
  type MemoryStoreInput,
  type StateStore,
} from '@loopsmith/core';

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why will with into about over under than then there their them they you your we our not no can could should would'.split(
    ' ',
  ),
);

/** Natural-language text → safe FTS5 query (every term quoted, OR-joined). */
export function buildFtsQuery(text: string, maxTerms = 12): string {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
    const term = match[0];
    if (STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= maxTerms) break;
  }
  // Quoting neutralises FTS5 syntax (NEAR, AND, column filters, `*`).
  return [...terms].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export interface MemoryManagerOptions {
  maxContentChars?: number;
}

/**
 * Long-term memory backed by SQLite FTS5 (BM25 ranking). Deliberately no
 * embeddings or vector store: keyword retrieval is deterministic, inspectable
 * and sufficient for explicitly saved facts. A vector backend can implement
 * the same {@link MemoryService} contract later.
 */
export class MemoryManager implements MemoryService {
  private readonly maxContentChars: number;

  constructor(
    private readonly db: StateStore,
    options: MemoryManagerOptions = {},
  ) {
    this.maxContentChars = options.maxContentChars ?? 4000;
  }

  store(input: MemoryStoreInput): MemoryRecord {
    const content = input.content.trim();
    if (content === '')
      throw new LoopSmithError('invalid_tool_arguments', 'Memory content is empty');
    if (content.length > this.maxContentChars) {
      throw new LoopSmithError(
        'invalid_tool_arguments',
        `Memory content exceeds ${this.maxContentChars} characters`,
      );
    }
    const scope = input.scope ?? 'session';
    if (scope === 'session' && !input.sessionId) {
      throw new LoopSmithError(
        'invalid_tool_arguments',
        'Session-scoped memory requires a session id',
      );
    }
    // Idempotency for repeated saves of the same fact in the same scope.
    const existing = this.db
      .listMemory({
        ...(scope === 'session' && input.sessionId ? { sessionId: input.sessionId } : {}),
        scope,
        limit: 200,
      })
      .find((m) => m.content === content);
    if (existing) return existing;
    return this.db.storeMemory({
      scope,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      content,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      source: input.source ?? 'api',
    });
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
    const fts = buildFtsQuery(query);
    if (!fts) return [];
    return this.db.searchMemory(fts, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      scope: options.scope ?? 'all',
      limit: options.limit ?? 5,
    });
  }

  list(
    options: { sessionId?: string; scope?: 'session' | 'global'; limit?: number } = {},
  ): MemoryRecord[] {
    return this.db.listMemory(options);
  }
}
