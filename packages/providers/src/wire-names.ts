import { createHash } from 'node:crypto';
import { LoopSmithError } from '@loopsmith/core';

/**
 * LoopSmith tool names are namespaced with dots (`workspace.read`), but both
 * Anthropic and OpenAI restrict function names to `^[a-zA-Z0-9_-]{1,64}$`.
 * A ToolNameMap translates in both directions for one request and rejects
 * collisions instead of silently routing a call to the wrong tool.
 */
const WIRE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolNameMap {
  private readonly toWire = new Map<string, string>();
  private readonly fromWire = new Map<string, string>();

  constructor(names: Iterable<string>) {
    for (const name of names) {
      let wire = name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (wire.length > 64) {
        wire = `${wire.slice(0, 55)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
      }
      if (!WIRE_PATTERN.test(wire)) {
        throw new LoopSmithError(
          'configuration',
          `Tool name cannot be encoded for providers: ${name}`,
        );
      }
      const existing = this.fromWire.get(wire);
      if (existing && existing !== name) {
        throw new LoopSmithError(
          'configuration',
          `Tool names collide on the wire: ${existing} / ${name}`,
        );
      }
      this.toWire.set(name, wire);
      this.fromWire.set(wire, name);
    }
  }

  wire(name: string): string {
    return this.toWire.get(name) ?? name.replace(/\./g, '__');
  }

  /** Unknown wire names are returned unchanged so the runtime reports `unknown_tool`. */
  canonical(wire: string): string {
    return this.fromWire.get(wire) ?? wire;
  }
}
