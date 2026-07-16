import { Effect, Layer } from "effect"
import { AuthStore, ModelCatalog } from "@xandreed/engine"
import type { Credential, ModelCatalogEntryType } from "@xandreed/engine"

const OPENCODE_MODELS = [
  "glm-5.2", "glm-5.1",
  "kimi-k2.7-code", "kimi-k2.6",
  "mimo-v2.5-pro", "mimo-v2.5",
  "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
  "minimax-m3", "minimax-m2.7",
  "deepseek-v4-pro", "deepseek-v4-flash",
] as const

const MODELS: Readonly<Record<string, ReadonlyArray<string>>> = {
  opencode: OPENCODE_MODELS,
  "openai-codex": [
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  openai: [
    "gpt-5",
    "gpt-5.1",
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  anthropic: ["claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"],
  google: ["gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash"],
}

export const configuredModelCatalog = (
  credentials: ReadonlyMap<string, Credential>,
): ReadonlyArray<ModelCatalogEntryType> =>
  [...credentials].flatMap(([provider, credential]) =>
    (MODELS[provider] ?? []).map((model) => ({
      selection: `${provider}:${model}`,
      label:
        provider === "openai-codex"
          ? `OpenAI subscription · ${model}`
          : provider === "openai"
            ? `OpenAI API key · ${model}`
            : undefined,
      provider,
      credential: credential.type,
    })),
  )

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

/** The reasoning controls accepted by each routed model. `none` on the
 * gpt-5.6 subscription dialect is live-probed (2026-07-16: accepted,
 * reasoning_tokens 0; `minimal` rejected). */
export const reasoningEffortsFor = (selection: string): ReadonlyArray<ReasoningEffort> => {
  if (/^openai-codex:gpt-5\.6-(luna|sol|terra)$/.test(selection)) {
    return ["none", "low", "medium", "high", "xhigh", "max"]
  }
  if (/^openai-codex:gpt-5/.test(selection)) {
    return ["low", "medium", "high", "xhigh"]
  }
  if (/^openai:gpt-5/.test(selection)) return ["low", "medium", "high"]
  return []
}

export const ConfiguredModelCatalogLive = Layer.effect(
  ModelCatalog,
  Effect.map(AuthStore, (auth) => ({
    list: auth.all.pipe(Effect.orElseSucceed(() => new Map<string, Credential>()), Effect.map(configuredModelCatalog)),
  })),
)
