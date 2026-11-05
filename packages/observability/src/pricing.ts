/**
 * Known list prices (USD per million tokens) used for *estimated* cost.
 * Source: Anthropic first-party API pricing table, as cached on 2026-10-06.
 * Prices change; treat estimates as indicative only. Models that are not
 * listed (including every OpenAI-compatible model) report no cost estimate
 * unless the operator registers a price with {@link registerPricing}.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'anthropic:claude-opus-5-5': { input: 4, output: 20 },
  'anthropic:claude-opus-5': { input: 5, output: 25 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10 },
  'anthropic:claude-sonnet-5': { input: 2, output: 10 },
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'anthropic:claude-fable-5-1': { input: 10, output: 50 },
};

export const PRICING_AS_OF = '2026-10-06';

export function registerPricing(
  provider: string,
  model: string,
  input: number,
  output: number,
): void {
  PRICES[`${provider}:${model}`] = { input, output };
}

export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES[`${provider}:${model}`];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
