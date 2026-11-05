import {
  LoopSmithError,
  Redactor,
  type AgentModelConfig,
  type ModelProvider,
} from '@loopsmith/core';
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { FallbackProvider, ResilientProvider, type RetryPolicy } from './resilient.js';

export interface ProviderInfo {
  name: string;
  kind: ModelProvider['kind'];
  defaultModel: string;
  isDefault: boolean;
  /** Human-readable configuration status; never includes secret values. */
  status: string;
  baseURL?: string;
}

interface Entry {
  provider: ModelProvider;
  info: Omit<ProviderInfo, 'isDefault'>;
}

/**
 * Named provider registry. Every registered provider is wrapped in a
 * ResilientProvider, so retry/backoff/timeout behaviour is uniform no matter
 * which vendor (or mock) is behind it.
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>();
  private defaultName: string | undefined;

  constructor(private readonly retry: Partial<RetryPolicy> = {}) {}

  register(
    provider: ModelProvider,
    info: { status?: string; baseURL?: string; resilient?: boolean } = {},
  ): void {
    const wrapped =
      info.resilient === false ? provider : new ResilientProvider(provider, { policy: this.retry });
    this.entries.set(provider.name, {
      provider: wrapped,
      info: {
        name: provider.name,
        kind: provider.kind,
        defaultModel: provider.defaultModel,
        status: info.status ?? 'ready',
        ...(info.baseURL ? { baseURL: info.baseURL } : {}),
      },
    });
    this.defaultName ??= provider.name;
  }

  /** Register an ordered fallback chain under a new name. */
  registerFallback(name: string, members: string[]): void {
    const chain = members.map((m) => ({ provider: this.get(m) }));
    this.entries.set(name, {
      provider: new FallbackProvider(name, chain),
      info: {
        name,
        kind: 'composite',
        defaultModel: chain[0]?.provider.defaultModel ?? 'unknown',
        status: `fallback: ${members.join(' → ')}`,
      },
    });
  }

  setDefault(name: string): void {
    if (!this.entries.has(name)) {
      throw new LoopSmithError(
        'configuration',
        `Unknown provider "${name}". Known: ${this.names().join(', ')}`,
      );
    }
    this.defaultName = name;
  }

  get default(): string {
    if (!this.defaultName)
      throw new LoopSmithError('configuration', 'No model provider registered');
    return this.defaultName;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get(name: string): ModelProvider {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new LoopSmithError(
        'configuration',
        `Unknown provider "${name}". Known: ${this.names().join(', ')}`,
      );
    }
    return entry.provider;
  }

  /** Resolve the provider and model an agent should use. */
  resolve(
    config: AgentModelConfig | undefined,
    override?: string,
  ): { provider: ModelProvider; model: string } {
    const name = override ?? config?.provider ?? this.default;
    const provider = this.get(name);
    // An explicit override means "run this agent on that provider", so the
    // agent's vendor-specific model id no longer applies.
    const model =
      override && override !== config?.provider
        ? provider.defaultModel
        : (config?.model ?? provider.defaultModel);
    return { provider, model };
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  list(): ProviderInfo[] {
    return [...this.entries.values()].map((e) => ({
      ...e.info,
      isDefault: e.info.name === this.defaultName,
    }));
  }
}

export interface EnvProviderOptions {
  env?: NodeJS.ProcessEnv;
  redactor?: Redactor;
  retry?: Partial<RetryPolicy>;
}

/**
 * Register live providers from environment variables. Nothing here is
 * required for the offline demo; missing credentials only mark a provider as
 * not ready. Secret values are registered with the redactor and never logged.
 */
export function registerEnvProviders(
  registry: ProviderRegistry,
  options: EnvProviderOptions = {},
): void {
  const env = options.env ?? process.env;
  const redactor = options.redactor ?? new Redactor();
  const timeoutMs = env.LOOPSMITH_PROVIDER_TIMEOUT_MS
    ? Number(env.LOOPSMITH_PROVIDER_TIMEOUT_MS)
    : undefined;

  const anthropicKey = env.ANTHROPIC_API_KEY;
  redactor.addSecret(anthropicKey);
  registry.register(
    new AnthropicProvider({
      ...(anthropicKey ? { apiKey: anthropicKey } : {}),
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      defaultModel: env.LOOPSMITH_ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
      ...(timeoutMs ? { timeoutMs } : {}),
      redactor,
    }),
    {
      status: anthropicKey ? 'ready (ANTHROPIC_API_KEY set)' : 'needs ANTHROPIC_API_KEY',
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    },
  );

  const openaiKey = env.OPENAI_API_KEY;
  redactor.addSecret(openaiKey);
  const openaiModel = env.LOOPSMITH_OPENAI_MODEL ?? env.OPENAI_MODEL;
  if (openaiModel) {
    registry.register(
      new OpenAICompatibleProvider({
        ...(openaiKey ? { apiKey: openaiKey } : {}),
        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
        defaultModel: openaiModel,
        ...(timeoutMs ? { timeoutMs } : {}),
        redactor,
      }),
      {
        status:
          openaiKey || env.OPENAI_BASE_URL ? 'ready' : 'needs OPENAI_API_KEY or OPENAI_BASE_URL',
        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      },
    );
  }

  const fallback = env.LOOPSMITH_FALLBACK?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fallback && fallback.length > 1) registry.registerFallback('fallback', fallback);
}
