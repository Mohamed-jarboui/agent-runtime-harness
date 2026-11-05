import {
  newId,
  nowIso,
  Redactor,
  type EventInput,
  type EventSink,
  type RuntimeEvent,
  type StateStore,
} from '@loopsmith/core';

export type EventListener = (event: RuntimeEvent) => void;

export interface EventBusOptions {
  store?: StateStore;
  redactor?: Redactor;
}

/**
 * Fan-out of structured runtime events. Every event is redacted first, then
 * persisted (so traces survive crashes), then dispatched to listeners.
 * Listener failures are isolated: observability must never break execution.
 */
export class EventBus implements EventSink {
  private readonly listeners = new Set<EventListener>();
  private readonly store: StateStore | undefined;
  readonly redactor: Redactor;
  private listenerErrors = 0;

  constructor(options: EventBusOptions = {}) {
    this.store = options.store;
    this.redactor = options.redactor ?? new Redactor();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: EventInput): RuntimeEvent {
    const event: RuntimeEvent = this.redactor.redact({
      ...input,
      id: newId('evt'),
      timestamp: input.timestamp ?? nowIso(),
    });
    this.store?.appendEvent(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listenerErrors += 1;
      }
    }
    return event;
  }

  get droppedListenerErrors(): number {
    return this.listenerErrors;
  }
}
