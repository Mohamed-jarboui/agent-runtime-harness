import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { LoopSmithError, type JsonSchema, type PermissionCategory } from '@loopsmith/core';
import type { RegisteredTool, ToolRegistry } from '@loopsmith/tools';

export interface McpServerConfig {
  /** Short server name, used to namespace tools: `mcp.<name>.<tool>`. */
  name: string;
  command: string;
  args?: string[];
  /** Extra environment for the server. The parent env is NOT inherited (only safe defaults). */
  env?: Record<string, string>;
  cwd?: string;
  /** Permission category applied to every tool from this server (default `external` → approval). */
  category?: PermissionCategory;
  /** Per-tool overrides by MCP tool name. */
  toolCategories?: Record<string, PermissionCategory>;
  /** Tools from this server that are safe to re-run after interruption. */
  idempotentTools?: string[];
  timeoutMs?: number;
  /** Only expose these MCP tool names (allow-list). */
  include?: string[];
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}

const NAME_SEGMENT = /[^a-z0-9_-]/g;

function segment(value: string): string {
  const s = value
    .toLowerCase()
    .replace(NAME_SEGMENT, '_')
    .replace(/^[^a-z]+/, '');
  return s || 'tool';
}

/**
 * Minimal MCP client over stdio. Remote tools are converted into ordinary
 * LoopSmith tools, so they pass through the exact same validation, policy,
 * approval, timeout, output-limit and tracing path as native tools. MCP
 * annotations (e.g. `readOnlyHint`) are untrusted hints and are ignored for
 * permission purposes; operators set categories explicitly.
 */
export class McpToolSource {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(readonly config: McpServerConfig) {}

  get connected(): boolean {
    return this.client !== undefined;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(this.config.env ?? {}) },
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'loopsmith', version: '0.1.0' });
    try {
      await client.connect(this.transport, { timeout: this.config.timeoutMs ?? 10_000 });
    } catch (err) {
      await this.transport.close().catch(() => undefined);
      this.transport = undefined;
      throw new LoopSmithError(
        'configuration',
        `Could not connect to MCP server "${this.config.name}"`,
        { cause: err },
      );
    }
    this.client = client;
  }

  async listTools(): Promise<RegisteredTool[]> {
    const client = this.requireClient();
    const descriptors: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.config.timeoutMs ?? 10_000,
      });
      descriptors.push(...(result.tools as McpToolDescriptor[]));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return descriptors
      .filter((d) => !this.config.include || this.config.include.includes(d.name))
      .map((d) => this.toTool(d));
  }

  private toTool(descriptor: McpToolDescriptor): RegisteredTool {
    const name = `mcp.${segment(this.config.name)}.${segment(descriptor.name)}`;
    const schema: JsonSchema = { type: 'object', ...(descriptor.inputSchema ?? {}) };
    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(schema);
    } catch {
      validate = this.ajv.compile({ type: 'object' });
    }
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    return {
      name,
      description: `[MCP ${this.config.name}] ${descriptor.description ?? descriptor.name}`.slice(
        0,
        1024,
      ),
      category: this.config.toolCategories?.[descriptor.name] ?? this.config.category ?? 'external',
      idempotent: this.config.idempotentTools?.includes(descriptor.name) ?? false,
      timeoutMs,
      source: 'mcp',
      inputSchema: schema,
      validateInput: (input) =>
        validate(input)
          ? { ok: true, value: input }
          : {
              ok: false,
              issues: (validate.errors ?? []).map(
                (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
              ),
            },
      execute: async (input, context) => {
        const client = this.requireClient();
        const result = (await client.callTool(
          { name: descriptor.name, arguments: (input ?? {}) as Record<string, unknown> },
          undefined,
          { signal: context.signal, timeout: timeoutMs },
        )) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
          structuredContent?: unknown;
        };
        const text = (result.content ?? [])
          .map((part) =>
            part.type === 'text' ? (part.text ?? '') : `[${part.type} content omitted]`,
          )
          .join('\n');
        if (result.isError)
          throw new LoopSmithError(
            'tool_execution',
            `MCP tool ${descriptor.name} failed: ${text.slice(0, 500)}`,
          );
        return result.structuredContent ?? text;
      },
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
    await this.transport?.close().catch(() => undefined);
    this.transport = undefined;
  }

  private requireClient(): Client {
    if (!this.client)
      throw new LoopSmithError(
        'configuration',
        `MCP server "${this.config.name}" is not connected`,
      );
    return this.client;
  }
}

/** Connect to an MCP server, discover its tools and register them. */
export async function registerMcpServer(
  registry: ToolRegistry,
  config: McpServerConfig,
): Promise<{ source: McpToolSource; tools: RegisteredTool[] }> {
  const source = new McpToolSource(config);
  await source.connect();
  const tools = await source.listTools();
  for (const tool of tools) registry.register(tool, { replace: true });
  return { source, tools };
}
