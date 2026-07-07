// AUTO-GENERATED — do not edit by hand.
// Source: https://models.dev/api.json (snapshot 2026-07-07)
// Regenerate: `bun run generate-models` (packages/core/scripts/generateModelCatalog.ts).
//
// Keyed by "<provider>:<modelId>". Carries each model's real context window,
// max output tokens, and (when models.dev reports it) USD-per-1M-token pricing
// for the three providers efferent talks to. Consumed by `contextWindowFor`
// and `costUsd` in ./Model.ts (both fall back gracefully for unknown ids).

export interface CatalogEntry {
  readonly contextWindow: number
  readonly maxTokens: number
  /** USD per 1M tokens (models.dev). Absent when the source omits pricing. */
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
  }
}

export const MODEL_CATALOG: Record<string, CatalogEntry> = {
  "anthropic:claude-fable-5": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 10, output: 50, cacheRead: 1 } },
  "anthropic:claude-haiku-4-5": { contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5, cacheRead: 0.1 } },
  "anthropic:claude-haiku-4-5-20251001": { contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5, cacheRead: 0.1 } },
  "anthropic:claude-opus-4-1": { contextWindow: 200000, maxTokens: 32000, cost: { input: 15, output: 75, cacheRead: 1.5 } },
  "anthropic:claude-opus-4-1-20250805": { contextWindow: 200000, maxTokens: 32000, cost: { input: 15, output: 75, cacheRead: 1.5 } },
  "anthropic:claude-opus-4-5": { contextWindow: 200000, maxTokens: 64000, cost: { input: 5, output: 25, cacheRead: 0.5 } },
  "anthropic:claude-opus-4-5-20251101": { contextWindow: 200000, maxTokens: 64000, cost: { input: 5, output: 25, cacheRead: 0.5 } },
  "anthropic:claude-opus-4-6": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5 } },
  "anthropic:claude-opus-4-7": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5 } },
  "anthropic:claude-opus-4-8": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5 } },
  "anthropic:claude-sonnet-4-5": { contextWindow: 1000000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3 } },
  "anthropic:claude-sonnet-4-5-20250929": { contextWindow: 1000000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3 } },
  "anthropic:claude-sonnet-4-6": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 3, output: 15, cacheRead: 0.3 } },
  "anthropic:claude-sonnet-5": { contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2 } },
  "google:gemini-2.0-flash": { contextWindow: 1048576, maxTokens: 8192, cost: { input: 0.1, output: 0.4, cacheRead: 0.025 } },
  "google:gemini-2.0-flash-lite": { contextWindow: 1048576, maxTokens: 8192, cost: { input: 0.075, output: 0.3, cacheRead: 0.075 } },
  "google:gemini-2.5-flash": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.3, output: 2.5, cacheRead: 0.03 } },
  "google:gemini-2.5-flash-lite": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.1, output: 0.4, cacheRead: 0.01 } },
  "google:gemini-2.5-pro": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "google:gemini-3-flash-preview": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.5, output: 3, cacheRead: 0.05 } },
  "google:gemini-3-pro-preview": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 2, output: 12, cacheRead: 0.2 } },
  "google:gemini-3.1-flash-lite": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.25, output: 1.5, cacheRead: 0.025 } },
  "google:gemini-3.1-flash-lite-preview": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.25, output: 1.5, cacheRead: 0.025 } },
  "google:gemini-3.1-pro-preview": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 2, output: 12, cacheRead: 0.2 } },
  "google:gemini-3.1-pro-preview-customtools": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 2, output: 12, cacheRead: 0.2 } },
  "google:gemini-3.5-flash": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 1.5, output: 9, cacheRead: 0.15 } },
  "google:gemini-flash-latest": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.3, output: 2.5, cacheRead: 0.075 } },
  "google:gemini-flash-lite-latest": { contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.1, output: 0.4, cacheRead: 0.025 } },
  "google:gemma-4-26b-a4b-it": { contextWindow: 262144, maxTokens: 32768 },
  "google:gemma-4-31b-it": { contextWindow: 262144, maxTokens: 32768 },
  "openai:gpt-4": { contextWindow: 8192, maxTokens: 8192, cost: { input: 30, output: 60, cacheRead: 30 } },
  "openai:gpt-4-turbo": { contextWindow: 128000, maxTokens: 4096, cost: { input: 10, output: 30, cacheRead: 10 } },
  "openai:gpt-4.1": { contextWindow: 1047576, maxTokens: 32768, cost: { input: 2, output: 8, cacheRead: 0.5 } },
  "openai:gpt-4.1-mini": { contextWindow: 1047576, maxTokens: 32768, cost: { input: 0.4, output: 1.6, cacheRead: 0.1 } },
  "openai:gpt-4.1-nano": { contextWindow: 1047576, maxTokens: 32768, cost: { input: 0.1, output: 0.4, cacheRead: 0.025 } },
  "openai:gpt-4o": { contextWindow: 128000, maxTokens: 16384, cost: { input: 2.5, output: 10, cacheRead: 1.25 } },
  "openai:gpt-4o-2024-05-13": { contextWindow: 128000, maxTokens: 4096, cost: { input: 5, output: 15, cacheRead: 5 } },
  "openai:gpt-4o-2024-08-06": { contextWindow: 128000, maxTokens: 16384, cost: { input: 2.5, output: 10, cacheRead: 1.25 } },
  "openai:gpt-4o-2024-11-20": { contextWindow: 128000, maxTokens: 16384, cost: { input: 2.5, output: 10, cacheRead: 1.25 } },
  "openai:gpt-4o-mini": { contextWindow: 128000, maxTokens: 16384, cost: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
  "openai:gpt-5": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5-codex": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5-mini": { contextWindow: 400000, maxTokens: 128000, cost: { input: 0.25, output: 2, cacheRead: 0.025 } },
  "openai:gpt-5-nano": { contextWindow: 400000, maxTokens: 128000, cost: { input: 0.05, output: 0.4, cacheRead: 0.005 } },
  "openai:gpt-5-pro": { contextWindow: 400000, maxTokens: 272000, cost: { input: 15, output: 120, cacheRead: 15 } },
  "openai:gpt-5.1": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5.1-chat-latest": { contextWindow: 128000, maxTokens: 16384, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5.1-codex": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5.1-codex-max": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  "openai:gpt-5.1-codex-mini": { contextWindow: 400000, maxTokens: 128000, cost: { input: 0.25, output: 2, cacheRead: 0.025 } },
  "openai:gpt-5.2": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.2-chat-latest": { contextWindow: 128000, maxTokens: 16384, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.2-codex": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.2-pro": { contextWindow: 400000, maxTokens: 128000, cost: { input: 21, output: 168, cacheRead: 21 } },
  "openai:gpt-5.3-chat-latest": { contextWindow: 128000, maxTokens: 16384, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.3-codex": { contextWindow: 400000, maxTokens: 128000, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.3-codex-spark": { contextWindow: 128000, maxTokens: 32000, cost: { input: 1.75, output: 14, cacheRead: 0.175 } },
  "openai:gpt-5.4": { contextWindow: 1050000, maxTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25 } },
  "openai:gpt-5.4-mini": { contextWindow: 400000, maxTokens: 128000, cost: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
  "openai:gpt-5.4-nano": { contextWindow: 400000, maxTokens: 128000, cost: { input: 0.2, output: 1.25, cacheRead: 0.02 } },
  "openai:gpt-5.4-pro": { contextWindow: 1050000, maxTokens: 128000, cost: { input: 30, output: 180, cacheRead: 30 } },
  "openai:gpt-5.5": { contextWindow: 1050000, maxTokens: 128000, cost: { input: 5, output: 30, cacheRead: 0.5 } },
  "openai:gpt-5.5-pro": { contextWindow: 1050000, maxTokens: 128000, cost: { input: 30, output: 180, cacheRead: 30 } },
  "openai:o1": { contextWindow: 200000, maxTokens: 100000, cost: { input: 15, output: 60, cacheRead: 7.5 } },
  "openai:o1-pro": { contextWindow: 200000, maxTokens: 100000, cost: { input: 150, output: 600, cacheRead: 150 } },
  "openai:o3": { contextWindow: 200000, maxTokens: 100000, cost: { input: 2, output: 8, cacheRead: 0.5 } },
  "openai:o3-deep-research": { contextWindow: 200000, maxTokens: 100000, cost: { input: 10, output: 40, cacheRead: 2.5 } },
  "openai:o3-mini": { contextWindow: 200000, maxTokens: 100000, cost: { input: 1.1, output: 4.4, cacheRead: 0.55 } },
  "openai:o3-pro": { contextWindow: 200000, maxTokens: 100000, cost: { input: 20, output: 80, cacheRead: 20 } },
  "openai:o4-mini": { contextWindow: 200000, maxTokens: 100000, cost: { input: 1.1, output: 4.4, cacheRead: 0.275 } },
  "openai:o4-mini-deep-research": { contextWindow: 200000, maxTokens: 100000, cost: { input: 2, output: 8, cacheRead: 0.5 } },
  "opencode:deepseek-v4-flash": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:deepseek-v4-pro": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:glm-5": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:glm-5.1": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:kimi-k2.5": { contextWindow: 256000, maxTokens: 8192 },
  "opencode:kimi-k2.6": { contextWindow: 256000, maxTokens: 8192 },
  "opencode:mimo-v2.5": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:mimo-v2.5-pro": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:minimax-m2.5": { contextWindow: 200000, maxTokens: 8192 },
  "opencode:minimax-m2.7": { contextWindow: 200000, maxTokens: 8192 },
  "opencode:minimax-m3": { contextWindow: 200000, maxTokens: 8192 },
  "opencode:qwen3.6-plus": { contextWindow: 128000, maxTokens: 8192 },
  "opencode:qwen3.7-max": { contextWindow: 128000, maxTokens: 8192 },
}
