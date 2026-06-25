import { Schema } from "effect"
import { MODEL_CATALOG } from "./modelCatalog.generated.js"

/**
 * Which LLM vendor backs a selection. Each maps to one `@effect/ai`
 * provider package in `@xandreed/sdk-adapters` (`@effect/ai-google` /
 * `@effect/ai-openai`); the router picks the implementation at call time.
 */
export const Provider = Schema.Literal("google", "openai", "anthropic", "opencode", "ollama")
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
    if (head === "google" || head === "openai" || head === "anthropic" || head === "opencode" || head === "ollama") {
      return { provider: head, modelId: tail }
    }
  }
  // No provider prefix → infer from the id shape; default to Google.
  const lower = raw.toLowerCase()
  const provider: Provider = /^claude/i.test(raw)
    ? "anthropic"
    : /^(gpt|o\d|chatgpt|text-|davinci)/i.test(raw)
      ? "openai"
      : /^gemini/i.test(raw)
        ? "google"
        : /^(glm|kimi|deepseek|mimo|minimax|qwen)/i.test(raw)
          ? "opencode"
          : "google"
  return { provider, modelId: raw }
}

/** The provider used when nothing is configured (ultimate fallback). */
export const DefaultModel = "google:gemini-3.5-flash"

/**
 * The three model **roles** the agent runs on. One mental model, three knobs —
 * and a running agent NEVER picks its own model: its role is structural, set by
 * where the call originates, not by anything the model emits mid-flight.
 *
 * - `general` — the root conversation / orchestrator and any research /
 *               analysis sub-agent: the general-purpose brain. The `/model`
 *               switch sets it (persisted as `settings.model`).
 * - `code`    — the coding sub-agents (the fleet writing code). A sub-agent
 *               that writes code runs here; one that researches or orchestrates
 *               runs on `general`. The spawner picks which (general | code) —
 *               never an arbitrary model. Unset → general.
 * - `fast`    — one-shot helper calls off the loop: tool-output summaries,
 *               auto-approval judgments, session titles. Helper-only — never a
 *               sub-agent's role. Unset → general.
 *
 * Roles, not model names, are the stable vocabulary: the UI labels the bar and
 * token spend by role, `:model code` / `:model fast` configure them, and
 * swapping a provider never changes what the roles mean. Helper calls reach the
 * fast tier through `UtilityLlm.complete(prompt, { role: "fast" })`; the loop
 * reaches the code/general tiers by spawning a sub-agent (`RunContext.modelRole`).
 */
export type ModelRole = "general" | "fast" | "code"

export const MODEL_ROLES: ReadonlyArray<ModelRole> = ["general", "fast", "code"]

/**
 * The roles a spawned sub-agent may run as — `general` (research / analysis /
 * orchestration) or `code` (writing code). `fast` is helper-only, never a
 * sub-agent's role.
 */
export type AgentModelRole = "general" | "code"

export const AGENT_MODEL_ROLES: ReadonlyArray<AgentModelRole> = ["general", "code"]

/** The settings keys backing each role (structural — avoids a Settings import cycle). */
export interface RoleModelSettings {
  readonly model: string
  readonly fastModel?: string | undefined
  readonly codeModel?: string | undefined
}

/**
 * Resolve a role to its `"<provider>:<modelId>"` string. `fast` and `code` fall
 * back to `general` when unset. Pure — the single place the chain lives (router,
 * utility tier, settings UI all call this instead of re-deriving it).
 */
export const modelForRole = (settings: RoleModelSettings, role: ModelRole): string => {
  switch (role) {
    case "general":
      return settings.model
    case "fast":
      return settings.fastModel ?? settings.model
    case "code":
      return settings.codeModel ?? settings.model
  }
}

/** Whether the role is explicitly configured (vs falling back to `general`). */
export const roleIsConfigured = (settings: RoleModelSettings, role: ModelRole): boolean => {
  switch (role) {
    case "general":
      return true
    case "fast":
      return settings.fastModel !== undefined
    case "code":
      return settings.codeModel !== undefined
  }
}

/**
 * Whether a **distinct** code model is configured — `codeModel` is set and
 * differs from the general model. This is the gate for routing code-writing to
 * the `code` tier: when it's false (unset, or the same string as `model`),
 * delegating the implementation to a `code`-tier sub-agent is pure overhead —
 * the same model would back it, so the root just edits directly (the fast path).
 * Pure; the root prompt builder reads it to decide whether to emit the
 * code-delegation policy.
 */
export const codeModelDistinct = (settings: RoleModelSettings): boolean =>
  settings.codeModel !== undefined &&
  settings.codeModel.length > 0 &&
  settings.codeModel !== settings.model

/** Parse a persisted `"<provider>:<modelId>"` into a full {@link ModelSelection}. */
export const selectionFromString = (raw: string): ModelSelection => {
  const { provider, modelId } = parseModel(raw)
  return { provider, modelId, contextWindow: contextWindowFor(provider, modelId) }
}

/** Default `"<provider>:<modelId>"` for a single provider (used when a key for it is set). */
export const defaultModelForProvider = (p: Provider): string =>
  p === "openai"
    ? "openai:gpt-4o"
    : p === "anthropic"
      ? "anthropic:claude-sonnet-4-5"
      : p === "opencode"
        ? "opencode:deepseek-v4-pro"
        : p === "ollama"
          ? "ollama:llama3.2"
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
  for (const p of ["anthropic", "google", "openai", "opencode", "ollama"] as const) {
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

/** Model ids from the generated models.dev snapshot for a provider. */
export const catalogModelIdsForProvider = (provider: Provider): ReadonlyArray<string> => {
  const prefix = `${provider}:`
  return Object.keys(MODEL_CATALOG)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

/**
 * Full {@link ModelInfo} rows for a provider straight from the bundled
 * models.dev snapshot. This is the **offline fallback** the model picker and
 * router use when a provider's live `/models` call is unreachable (transport
 * error, API down, rate-limited): a logged-in provider always contributes its
 * known models so a single outage never empties the picker. Empty for
 * providers absent from the snapshot (e.g. `ollama`, whose models are whatever
 * is pulled locally) — those legitimately have no static fallback.
 */
export const catalogModelsForProvider = (provider: Provider): ReadonlyArray<ModelInfo> =>
  catalogModelIdsForProvider(provider).map((modelId) => ({
    provider,
    modelId,
    displayName: modelId,
    contextWindow: contextWindowFor(provider, modelId),
  }))

/**
 * Context-window size for the status-bar gauge. Prefers the generated
 * catalogue (the real per-model limit from models.dev — neither Anthropic's nor
 * OpenAI's `/models` API reports it); falls back to a per-provider substring
 * heuristic for ids not yet in the catalogue (e.g. a model released since the
 * last `bun run generate-models`).
 */
/**
 * Ordered effort levels for the given provider + model.
 * `undefined` entries in the result mean "provider default".
 * Returns `undefined` when the provider/model has no effort concept.
 */
export const effortLevelsFor = (
  provider: Provider,
  _modelId: string,
): ReadonlyArray<string> | undefined => {
  switch (provider) {
    case "anthropic":
      return ["", "off", "low", "medium", "high"]
    case "openai":
      return ["", "none", "minimal", "low", "medium", "high"]
    case "google":
      return ["", "off", "minimal", "low", "medium", "high"]
    case "opencode":
      return ["", "off", "high"]
    case "ollama":
      return undefined
  }
}

export const effortSettingKeyFor = (
  provider: Provider,
):
  | "anthropicThinkingEffort"
  | "openAiReasoningEffort"
  | "geminiThinkingLevel"
  | "openCodeThinkingMode"
  | undefined => {
  switch (provider) {
    case "anthropic":
      return "anthropicThinkingEffort"
    case "openai":
      return "openAiReasoningEffort"
    case "google":
      return "geminiThinkingLevel"
    case "opencode":
      return "openCodeThinkingMode"
    case "ollama":
      return undefined
  }
}

/**
 * Estimated USD cost of one turn's token usage for `model`, from the generated
 * pricing snapshot (models.dev — prices are per 1M tokens). `cacheReadTokens`
 * is a subset of `inputTokens` billed at the cheaper cache-read rate; the rest
 * of the input is billed at the input rate. Returns `undefined` when the model
 * carries no pricing in the catalogue, so a caller shows "n/a" rather than a
 * wrong number. Pure — structural `usage` avoids a `LlmInfo` import cycle.
 */
export const costUsd = (
  model: string,
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
  },
): number | undefined => {
  const { provider, modelId } = parseModel(model)
  const cost = catalogLookup(provider, modelId)?.cost
  if (cost === undefined) return undefined
  const cachedIn = Math.min(usage.cacheReadTokens, usage.inputTokens)
  const freshIn = usage.inputTokens - cachedIn
  return (
    (freshIn * cost.input + cachedIn * cost.cacheRead + usage.outputTokens * cost.output) /
    1_000_000
  )
}

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
  if (provider === "opencode") {
    // OpenCode Go hosts a curated mix of open models; most are 128k today.
    if (id.includes("kimi")) return 256_000
    if (id.includes("minimax")) return 200_000
    return 128_000
  }
  if (provider === "ollama") return 128_000
  // openai
  if (id.includes("gpt-4.1")) return 1_047_576
  if (id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return 200_000
  }
  if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) return 128_000
  if (id.includes("gpt-4")) return 128_000
  return 128_000
}
