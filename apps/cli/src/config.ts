import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ExecutionLimitsSchema, PERMISSION_CATEGORIES, safeJsonParse } from '@loopsmith/core';

const Effect = z.enum(['allow', 'require_approval', 'deny']);

export const CliConfigSchema = z
  .object({
    workspace: z.string().optional(),
    database: z.string().optional(),
    provider: z.string().optional(),
    limits: ExecutionLimitsSchema.partial().optional(),
    policy: z
      .object({
        categories: z.partialRecord(z.enum(PERMISSION_CATEGORIES), Effect).optional(),
        tools: z.record(z.string(), Effect).optional(),
      })
      .optional(),
    compaction: z
      .object({
        strategy: z.enum(['summarize', 'truncate']).optional(),
        threshold: z.number().min(0.1).max(1).optional(),
        keepRecentTurns: z.number().int().min(1).optional(),
        elideToolOutputAbove: z.number().int().min(100).optional(),
      })
      .optional(),
    mcpServers: z
      .record(
        z.string(),
        z.object({
          command: z.string(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          cwd: z.string().optional(),
          category: z.enum(PERMISSION_CATEGORIES).optional(),
          idempotentTools: z.array(z.string()).optional(),
          include: z.array(z.string()).optional(),
          timeoutMs: z.number().int().positive().optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .strict();

export type CliConfig = z.infer<typeof CliConfigSchema>;

export const DEFAULT_CONFIG_FILE = 'loopsmith.config.json';
export const DEFAULT_DB = path.join('.loopsmith', 'loopsmith.db');

export interface LoadedConfig {
  config: CliConfig;
  file?: string;
  baseDir: string;
}

export function loadConfig(explicit?: string, cwd = process.cwd()): LoadedConfig {
  const file = explicit ? path.resolve(cwd, explicit) : path.join(cwd, DEFAULT_CONFIG_FILE);
  if (!existsSync(file)) {
    if (explicit) throw new Error(`Config file not found: ${file}`);
    return { config: {}, baseDir: cwd };
  }
  const parsed = safeJsonParse(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(`Invalid JSON in ${file}: ${parsed.error}`);
  const result = CliConfigSchema.safeParse(parsed.value);
  if (!result.success) {
    throw new Error(
      `Invalid config ${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return { config: result.data, file, baseDir: path.dirname(file) };
}

export const EXAMPLE_CONFIG: CliConfig = {
  workspace: '.',
  database: DEFAULT_DB,
  provider: 'mock',
  limits: {
    maxIterations: 12,
    maxToolCalls: 40,
    maxRuntimeMs: 300000,
    toolTimeoutMs: 30000,
    contextBudgetTokens: 100000,
  },
  policy: {
    categories: {
      write: 'require_approval',
      execute: 'deny',
      network: 'deny',
      destructive: 'deny',
    },
    tools: {},
  },
  compaction: { strategy: 'summarize', threshold: 0.8, keepRecentTurns: 6 },
  mcpServers: {
    demo: {
      command: 'node',
      args: ['examples/mcp-server/server.mjs'],
      category: 'external',
      enabled: false,
    },
  },
};
