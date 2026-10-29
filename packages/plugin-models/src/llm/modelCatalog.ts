import { Effect, Layer, Option } from "effect"
import { AuthStore, ModelCatalog, parseModelSelection } from "@xandreed/core"
import type { Credential, ModelCatalogEntryType } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"

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

/** OpenCode serves its GPT models through the OpenAI Responses protocol, the others through chat completions. */
export const usesOpenCodeResponses = (modelId: string): boolean => /^gpt-/i.test(modelId)

/** Subscription models that read text only. */
const TEXT_ONLY_CODEX: ReadonlySet<string> = new Set(["gpt-5.3-codex-spark"])

/**
 * Whether a built-in route sends a model images: Anthropic's Messages API,
 * the OpenAI Responses routes (`openai`, `openai-codex` but its text-only
 * Spark model, OpenCode's `gpt-*`) and Gemini's chat completions do;
 * OpenCode's other models are text-only until each is verified. A
 * configured endpoint says so itself (`ModelEndpoint.images`). Where it is
 * false, a request's images are sent as label lines.
 */
export const imageInputFor = (selection: string): boolean => Option.match(parseModelSelection(selection), {
  onNone: () => false,
  onSome: ({ provider, modelId }) => provider === "anthropic" || provider === "openai" || provider === "google"
    || (provider === "openai-codex" && !TEXT_ONLY_CODEX.has(modelId))
    || (provider === "opencode" && usesOpenCodeResponses(modelId)),
})

/**
 * Whether the route `buildProvider` sends a catalog model through reads
 * images: a configured endpoint of the provider's name by its `images`
 * (default false), a `local` credential's URL never, a built-in route by
 * `imageInputFor`.
 */
const routeReadsImages = (provider: string, model: string, credential: Credential, endpoints: ModelEndpoints): boolean =>
  Option.match(Option.fromNullishOr(endpoints[provider]), {
    onSome: (endpoint) => endpoint.images ?? false,
    onNone: () => !(credential.type === "local" && credential.baseUrl !== undefined) && imageInputFor(`${provider}:${model}`),
  })

/**
 * The models of every provider with a credential. Each entry's `input` is
 * what its route reads, as `buildProvider` routes it: `endpoints` (the
 * models plugin's configured ones; none by default) replace a built-in
 * route of their name.
 */
export const configuredModelCatalog = (
  credentials: ReadonlyMap<string, Credential>,
  endpoints: ModelEndpoints = {},
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
      input: routeReadsImages(provider, model, credential, endpoints) ? ["text", "image"] : ["text"],
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

/** The efforts of the public OpenAI API's vocabulary, which the OpenAI Responses routes and the chat-completions gateways take. */
export type PublicReasoningEffort = "low" | "medium" | "high"

/**
 * An effort in the public vocabulary: `xhigh` and `max` are `high`, `none`
 * is `low`, the others themselves. Only the subscription dialect takes the
 * whole vocabulary (and only it is probe-verified for `none`); every other
 * route clamps.
 */
export const publicReasoningEffort = (effort: ReasoningEffort): PublicReasoningEffort =>
  effort === "xhigh" || effort === "max" ? "high" : effort === "none" ? "low" : effort

/** The catalog over the AuthStore's credentials and the configured endpoints (`CurrentModelEndpoints`). */
export const ConfiguredModelCatalogLive = Layer.effect(
  ModelCatalog,
  Effect.all({ auth: AuthStore, endpoints: Effect.service(CurrentModelEndpoints) }).pipe(Effect.map(({ auth, endpoints }) => ({
    list: auth.all.pipe(
      Effect.orElseSucceed(() => new Map<string, Credential>()),
      Effect.map((credentials) => configuredModelCatalog(credentials, endpoints)),
    ),
  }))),
)
