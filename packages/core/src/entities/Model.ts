import { Schema } from "effect"
import { MODEL_CATALOG } from "./modelCatalog.generated.js"

/**
 * Which LLM vendor backs a selection. Each maps to one `@effect/ai`
 * provider package in `@efferent/adapters` (`@effect/ai-google` /
 * `@effect/ai-openai`); the router picks the implementation at call time.
 */
export const Provider = Schema.Literal("google", "openai", "anthropic")
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
    if (head === "google" || head === "openai" || head === "anthropic") {
      return { provider: head, modelId: tail }
    }
  }
  // No provider prefix → infer from the id shape; default to Google.
  const provider: Provider = /^claude/i.test(raw)
    ? "anthropic"
    : /^(gpt|o\d|chatgpt|text-|davinci)/i.test(raw)
      ? "openai"
      : "google"
  return { provider, modelId: raw }
}

/** The provider used when nothing is configured (ultimate fallback). */
export const DefaultModel = "google:gemini-3.5-flash"

/** Default `"<provider>:<modelId>"` for a single provider (used when a key for it is set). */
export const defaultModelForProvider = (p: Provider): string =>
  p === "openai"
    ? "openai:gpt-4o"
    : p === "anthropic"
      ? "anthropic:claude-sonnet-4-5"
      : DefaultModel

/**
 * Pick the default model from the providers that currently have a key.
 * Priority `anthropic → google → openai` when several are present; falls back
 * to {@link DefaultModel} when the list is empty. The pick is only a seed — a
 * `config.json` model, `EFFERENT_MODEL`, or `:model` all override it.
 */
export const defaultModelForProviders = (
  available: ReadonlyArray<Provider>,
): string => {
  for (const p of ["anthropic", "google", "openai"] as const) {
    if (available.includes(p)) return defaultModelForProvider(p)
  }
  return DefaultModel
}

/**
 * Look the model up in the generated catalogue (`modelCatalog.generated.ts`,
 * snapshotted from models.dev). Tries the exact `"<provider>:<modelId>"` key,
 * then retries with a trailing date stamp (`-YYYYMMDD`) stripped, since pinned
 * ids like `claude-opus-4-8-20260101` share a window with their base id.
 */
const catalogLookup = (provider: Provider, modelId: string) => {
  const exact = MODEL_CATALOG[`${provider}:${modelId}`]
  if (exact !== undefined) return exact
  const undated = modelId.replace(/-\d{6,}$/, "")
  return undated !== modelId ? MODEL_CATALOG[`${provider}:${undated}`] : undefined
}

/**
 * Context-window size for the status-bar gauge. Prefers the generated
 * catalogue (the real per-model limit from models.dev — neither Anthropic's nor
 * OpenAI's `/models` API reports it); falls back to a per-provider substring
 * heuristic for ids not yet in the catalogue (e.g. a model released since the
 * last `bun run generate-models`).
 */
export const contextWindowFor = (provider: Provider, modelId: string): number => {
  const cataloged = catalogLookup(provider, modelId)
  if (cataloged !== undefined) return cataloged.contextWindow
  const id = modelId.toLowerCase()
  if (provider === "google") {
    if (id.includes("1.5-pro")) return 2_000_000
    return 1_000_000
  }
  if (provider === "anthropic") {
    // Claude is 200k standard; some models expose a 1M-token beta window.
    if (id.includes("[1m]") || id.includes("-1m")) return 1_000_000
    return 200_000
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
