import { writeFileSync } from 'node:fs';
import type { RuntimeEvent, StateStore } from '@loopsmith/core';

/** Machine-readable trace: one JSON event per line, in emission order. */
export function eventsToJsonl(events: RuntimeEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

export function exportRunTrace(store: StateStore, rootRunId: string, outFile?: string): string {
  const jsonl = eventsToJsonl(store.listEvents({ rootRunId }));
  if (outFile) writeFileSync(outFile, jsonl, 'utf8');
  return jsonl;
}
