import { Config, Effect, Layer, Option, Redacted } from "effect"
import { AuthStore, ModelCatalog } from "@xandreed/core"
import type { Credential, ModelCatalogEntryType } from "@xandreed/core"

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
  vercel: ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash"],
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
            : provider === "vercel"
              ? `DeepSeek Flash ${model.includes("v4.1") ? "V4.1" : "V4"} · Vercel AI Gateway`
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
    list: Effect.gen(function* () {
      const credentials = yield* auth.all.pipe(Effect.orElseSucceed(() => new Map<string, Credential>()))
      const gatewayKey = yield* Config.option(Config.Redacted("AI_GATEWAY_API_KEY")).pipe(
        Effect.map(Option.filter((key) => Redacted.value(key).trim().length > 0)), Effect.orElseSucceed(() => Option.none()),
      )
      // Discovery needs credential presence, never the credential value.
      return configuredModelCatalog(Option.isSome(gatewayKey)
        ? new Map([...credentials, ["vercel", { type: "api_key" as const, key: "" }]]) : credentials)
    }),
  })),
)
