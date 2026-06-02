import { Schema } from "effect"

/**
 * Which LLM vendor backs a selection. Each maps to one `@effect/ai`
 * provider package in `@efferent/adapters` (`@effect/ai-google` /
 * `@effect/ai-openai`); the router picks the implementation at call time.
 */
export const Provider = Schema.Literal("google", "openai")
export type Provider = typeof Provider.Type

/**
 * The model the agent loop should use right now: a provider + the
 * provider-native model id. `contextWindow` is for display only (the
 * status-bar gauge); routing only needs `provider` + `modelId`.
 */
export interface ModelSelection {
  readonly provider: Provider
  readonly modelId: string
  readonly contextWindow: number
}

/** One entry in the live `/model` picker. */
export interface ModelInfo {
  readonly provider: Provider
  readonly modelId: string
  readonly displayName: string
  readonly contextWindow: number
}

/**
 * Settings persist the selection as a single `"<provider>:<modelId>"`
 * string. Parse is forgiving: a bare id with no recognised prefix is
 * assumed to be Google (the historical default provider).
 */
export const formatModel = (provider: Provider, modelId: string): string =>
  `${provider}:${modelId}`

export const parseModel = (raw: string): { provider: Provider; modelId: string } => {
  const idx = raw.indexOf(":")
  if (idx > 0) {
    const head = raw.slice(0, idx)
    const tail = raw.slice(idx + 1)
    if (head === "google" || head === "openai") {
      return { provider: head, modelId: tail }
    }
  }
  // No provider prefix → infer from the id shape; default to Google.
  const provider: Provider = /^(gpt|o\d|chatgpt|text-|davinci)/i.test(raw)
    ? "openai"
    : "google"
  return { provider, modelId: raw }
}

/** The provider used when nothing is configured. */
export const DefaultModel = "google:gemini-3.5-flash"

/**
 * Best-effort context-window size for the status-bar gauge when the live
 * model list (which carries the real limit) hasn't been fetched. Matches
 * on substrings of the id; falls back to a per-provider default.
 */
export const contextWindowFor = (provider: Provider, modelId: string): number => {
  const id = modelId.toLowerCase()
  if (provider === "google") {
    if (id.includes("1.5-pro")) return 2_000_000
    return 1_000_000
  }
  // openai
  if (id.includes("gpt-4.1")) return 1_047_576
  if (id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return 200_000
  }
  if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) return 128_000
  if (id.includes("gpt-4")) return 128_000
  return 128_000
}
