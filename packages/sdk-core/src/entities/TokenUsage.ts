/**
 * Per-turn token usage. `cacheReadTokens` is the portion of `inputTokens`
 * served from a provider-side cache (0 when uncached).
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
}
