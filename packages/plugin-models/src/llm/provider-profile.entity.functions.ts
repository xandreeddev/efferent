import { Option, Schema } from "effect"
import { parseModelSelection } from "@xandreed/core"
import type { ReasoningEffortType } from "@xandreed/core"
import { BuiltInProvider } from "./provider-profile.entity.js"
import type { ModelProfile, ProviderProfile, Route } from "./provider-profile.entity.js"

/**
 * The built-in providers, one profile each. The catalog, the image and
 * effort flags and the route builders read this table instead of naming a
 * provider.
 */

export const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
/** OpenCode serves GPT models through the OpenAI Responses protocol. */
export const OPENCODE_RESPONSES_API_URL = "https://opencode.ai/zen/v1"
/** Gemini through its OpenAI-compatible chat completions (Bearer API key). */
export const GOOGLE_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

/** OpenCode's GPT models, which it serves through the Responses protocol (the others through chat completions). */
const OPENCODE_RESPONSES_MODEL = /^gpt-/i

/** Subscription models that read text only. */
const TEXT_ONLY_CODEX: ReadonlySet<string> = new Set(["gpt-5.3-codex-spark"])

/** The public OpenAI API's efforts, which its GPT-5 models take. */
const PUBLIC_EFFORTS: ReadonlyArray<ReasoningEffortType> = ["low", "medium", "high"]
/** The subscription dialect's efforts on its GPT-5 models. */
const SUBSCRIPTION_EFFORTS: ReadonlyArray<ReasoningEffortType> = ["low", "medium", "high", "xhigh"]
/** The whole vocabulary, which the subscription's gpt-5.6 models take. `none`
 * is live-probed (2026-07-16: accepted, reasoning_tokens 0; `minimal` rejected). */
const ALL_EFFORTS: ReadonlyArray<ReasoningEffortType> = ["none", "low", "medium", "high", "xhigh", "max"]

const ANTHROPIC: Route = { _tag: "anthropic" }
const OPENAI_CODEX: Route = { _tag: "openai-codex" }
const OPENAI_RESPONSES: Route = { _tag: "openai-responses", apiUrl: Option.none(), strictJsonSchema: Option.none(), effort: "listed" }
/** UI tools contain genuinely optional fields. OpenAI strict schemas require
 * every property, so OpenCode's GPT models use normal function calling and
 * let Effect decode the domain schema. */
const OPENCODE_RESPONSES: Route = { _tag: "openai-responses", apiUrl: Option.some(OPENCODE_RESPONSES_API_URL), strictJsonSchema: Option.some(false), effort: "always" }
const OPENCODE_CHAT: Route = { _tag: "compat", moduleName: "OpenCode", chatUrl: OPENCODE_CHAT_URL, standardOnly: false, usage: { reasoning: true } }
/** Gemini takes no cache key, thinking defaults or call policy (standard
 * fields only), and its `completion_tokens` may leave its thoughts out, so
 * its reasoning reads 0. */
const GOOGLE_CHAT: Route = { _tag: "compat", moduleName: "Google", chatUrl: GOOGLE_CHAT_URL, standardOnly: true, usage: { reasoning: false } }

/**
 * The Claude models that bind thinking to the conversation's prefix: Fable
 * from 5.1, Opus, Sonnet and Haiku from 5.5, and every later version of the
 * four families (`claude-<family>-<major>-<minor>`, with or without a date).
 */
const bindsThinkingToPrefix = (id: string): boolean => {
  const version = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (version === null) return false
  const [, family, major, minor] = version
  const at = Number(major) * 100 + Number(minor ?? 0)
  return at >= (family === "fable" ? 501 : 505)
}

/** A profile over its catalog's ids and its rule for any model id. */
const profile = (
  label: Option.Option<string>,
  ids: ReadonlyArray<string>,
  traits: (modelId: string) => Omit<ModelProfile, "id">,
  routeOf: (modelId: string) => Route,
): ProviderProfile => {
  const modelOf = (id: string): ModelProfile => ({ id, ...traits(id) })
  return { label, models: ids.map(modelOf), modelOf, routeOf }
}

/** Every built-in provider's profile, in the catalog's order of providers. */
export const PROVIDER_PROFILES: { readonly [P in BuiltInProvider]: ProviderProfile } = {
  opencode: profile(
    Option.none(),
    [
      "glm-5.2", "glm-5.1",
      "kimi-k2.7-code", "kimi-k2.6",
      "mimo-v2.5-pro", "mimo-v2.5",
      "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
      "minimax-m3", "minimax-m2.7",
      "deepseek-v4-pro", "deepseek-v4-flash",
    ],
    // The GPT models read images; the chat models are text-only until each is verified.
    (id) => ({ images: OPENCODE_RESPONSES_MODEL.test(id), efforts: [], bindsThinking: false }),
    (id) => OPENCODE_RESPONSES_MODEL.test(id) ? OPENCODE_RESPONSES : OPENCODE_CHAT,
  ),
  "openai-codex": profile(
    Option.some("OpenAI subscription"),
    ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    (id) => ({
      images: !TEXT_ONLY_CODEX.has(id),
      efforts: /^gpt-5\.6-(luna|sol|terra)$/.test(id) ? ALL_EFFORTS : /^gpt-5/.test(id) ? SUBSCRIPTION_EFFORTS : [],
      bindsThinking: false,
    }),
    () => OPENAI_CODEX,
  ),
  openai: profile(
    Option.some("OpenAI API key"),
    ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    (id) => ({ images: true, efforts: /^gpt-5/.test(id) ? PUBLIC_EFFORTS : [], bindsThinking: false }),
    () => OPENAI_RESPONSES,
  ),
  anthropic: profile(
    Option.none(),
    ["claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"],
    (id) => ({ images: true, efforts: [], bindsThinking: bindsThinkingToPrefix(id) }),
    () => ANTHROPIC,
  ),
  google: profile(
    Option.none(),
    ["gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash"],
    () => ({ images: true, efforts: [], bindsThinking: false }),
    () => GOOGLE_CHAT,
  ),
}

const isBuiltIn = Schema.is(BuiltInProvider)

/** A provider's profile; none for a provider that is not built in. */
export const profileOf = (provider: string): Option.Option<ProviderProfile> =>
  isBuiltIn(provider) ? Option.some(PROVIDER_PROFILES[provider]) : Option.none()

/** A `"<provider>:<modelId>"` selection's model profile; none when it does not parse or its provider is not built in. */
export const modelProfileOf = (selection: string): Option.Option<ModelProfile> =>
  Option.flatMap(parseModelSelection(selection), ({ provider, modelId }) =>
    Option.map(profileOf(provider), (found) => found.modelOf(modelId)))
