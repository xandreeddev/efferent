import { describe, expect, it } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, modelRequestDescriptorOf, parseModelSelection } from "@xandreed/core"
import type { ModelCallPolicy } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { CLAUDE_CODE_SYSTEM } from "../auth/anthropicOAuth.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { configuredModelCatalog, imageInputFor, reasoningEffortsFor } from "./modelCatalog.js"
import { modelProfileOf, profileOf, PROVIDER_PROFILES } from "./provider-profile.entity.functions.js"
import { buildProvider } from "./providers.js"

/**
 * The built-in providers as they stand, pinned: every catalog model's
 * label, image input and efforts, each selection's descriptor settings
 * under three call contexts, and the URL and client each route sends
 * through. Models the catalog does not list follow their family's rule.
 */

type Family = keyof typeof SETTINGS

/** Selection, catalog label ("" for none), reads images, efforts (comma-joined), settings family. */
const CATALOG: ReadonlyArray<readonly [string, string, boolean, string, Family]> = [
  ["opencode:glm-5.2", "", false, "", "chat"],
  ["opencode:glm-5.1", "", false, "", "chat"],
  ["opencode:kimi-k2.7-code", "", false, "", "chat-thinking-high"],
  ["opencode:kimi-k2.6", "", false, "", "chat-thinking"],
  ["opencode:mimo-v2.5-pro", "", false, "", "chat"],
  ["opencode:mimo-v2.5", "", false, "", "chat"],
  ["opencode:qwen3.7-max", "", false, "", "chat-enable-thinking"],
  ["opencode:qwen3.7-plus", "", false, "", "chat-enable-thinking"],
  ["opencode:qwen3.6-plus", "", false, "", "chat-enable-thinking"],
  ["opencode:minimax-m3", "", false, "", "chat"],
  ["opencode:minimax-m2.7", "", false, "", "chat"],
  ["opencode:deepseek-v4-pro", "", false, "", "chat-thinking"],
  ["opencode:deepseek-v4-flash", "", false, "", "chat-thinking"],
  ["openai-codex:gpt-5.3-codex-spark", "OpenAI subscription · gpt-5.3-codex-spark", false, "low,medium,high,xhigh", "codex"],
  ["openai-codex:gpt-5.4", "OpenAI subscription · gpt-5.4", true, "low,medium,high,xhigh", "codex"],
  ["openai-codex:gpt-5.4-mini", "OpenAI subscription · gpt-5.4-mini", true, "low,medium,high,xhigh", "codex"],
  ["openai-codex:gpt-5.5", "OpenAI subscription · gpt-5.5", true, "low,medium,high,xhigh", "codex"],
  ["openai-codex:gpt-5.6-luna", "OpenAI subscription · gpt-5.6-luna", true, "none,low,medium,high,xhigh,max", "codex"],
  ["openai-codex:gpt-5.6-sol", "OpenAI subscription · gpt-5.6-sol", true, "none,low,medium,high,xhigh,max", "codex"],
  ["openai-codex:gpt-5.6-terra", "OpenAI subscription · gpt-5.6-terra", true, "none,low,medium,high,xhigh,max", "codex"],
  ["openai:gpt-5", "OpenAI API key · gpt-5", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.1", "OpenAI API key · gpt-5.1", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.2", "OpenAI API key · gpt-5.2", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.4", "OpenAI API key · gpt-5.4", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.4-mini", "OpenAI API key · gpt-5.4-mini", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.4-nano", "OpenAI API key · gpt-5.4-nano", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.5", "OpenAI API key · gpt-5.5", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.6-luna", "OpenAI API key · gpt-5.6-luna", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.6-sol", "OpenAI API key · gpt-5.6-sol", true, "low,medium,high", "responses-effort"],
  ["openai:gpt-5.6-terra", "OpenAI API key · gpt-5.6-terra", true, "low,medium,high", "responses-effort"],
  ["anthropic:claude-fable-5", "", true, "", "anthropic"],
  ["anthropic:claude-haiku-4-5", "", true, "", "anthropic"],
  ["anthropic:claude-opus-4-8", "", true, "", "anthropic"],
  ["anthropic:claude-sonnet-5", "", true, "", "anthropic"],
  ["google:gemini-3-flash", "", true, "", "standard-chat"],
  ["google:gemini-3.1-pro", "", true, "", "standard-chat"],
  ["google:gemini-3.5-flash", "", true, "", "standard-chat"],
]

/** Built-in selections the catalog does not list: reads images, efforts, settings family. */
const UNLISTED: ReadonlyArray<readonly [string, boolean, string, Family]> = [
  ["opencode:gpt-5.6-luna", true, "", "opencode-responses"],
  ["opencode:GPT-5.5", true, "", "opencode-responses"],
  ["openai-codex:gpt-5.7", true, "low,medium,high,xhigh", "codex"],
  ["openai-codex:gpt-6", true, "", "codex"],
  ["openai:gpt-4.1", true, "", "responses"],
  ["openai:o3", true, "", "responses"],
  ["anthropic:claude-next", true, "", "anthropic"],
  ["google:gemini-next", true, "", "standard-chat"],
]

/** The three call contexts: no cache key or policy; a cache key and a capped `max` effort; an effort of `none`. */
const CONTEXTS: ReadonlyArray<readonly [Option.Option<string>, Option.Option<ModelCallPolicy>]> = [
  [Option.none(), Option.none()],
  [Option.some("lane"), Option.some({ effort: "max", maxOutputTokens: 32 })],
  [Option.none(), Option.some({ effort: "none" })],
]

/** A family's descriptor settings in each context, as JSON (key order included). */
const SETTINGS = {
  chat: [`{}`, `{"prompt_cache_key":"lane","max_tokens":32,"reasoning_effort":"high"}`, `{"reasoning_effort":"low"}`],
  "chat-thinking": [
    `{"thinking":{"type":"enabled"}}`,
    `{"prompt_cache_key":"lane","thinking":{"type":"enabled"},"max_tokens":32,"reasoning_effort":"high"}`,
    `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`,
  ],
  "chat-thinking-high": [
    `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}`,
    `{"prompt_cache_key":"lane","thinking":{"type":"enabled"},"reasoning_effort":"high","max_tokens":32}`,
    `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`,
  ],
  "chat-enable-thinking": [
    `{"enable_thinking":true}`,
    `{"prompt_cache_key":"lane","enable_thinking":true,"max_tokens":32,"reasoning_effort":"high"}`,
    `{"enable_thinking":true,"reasoning_effort":"low"}`,
  ],
  "standard-chat": [`{}`, `{}`, `{}`],
  "opencode-responses": [
    `{"strictJsonSchema":false,"prompt_cache_key":"efferent"}`,
    `{"strictJsonSchema":false,"prompt_cache_key":"lane","max_output_tokens":32,"reasoning":{"effort":"high"}}`,
    `{"strictJsonSchema":false,"prompt_cache_key":"efferent","reasoning":{"effort":"low"}}`,
  ],
  responses: [`{"prompt_cache_key":"efferent"}`, `{"prompt_cache_key":"lane","max_output_tokens":32}`, `{"prompt_cache_key":"efferent"}`],
  "responses-effort": [
    `{"prompt_cache_key":"efferent"}`,
    `{"prompt_cache_key":"lane","max_output_tokens":32,"reasoning":{"effort":"high"}}`,
    `{"prompt_cache_key":"efferent","reasoning":{"effort":"low"}}`,
  ],
  codex: [
    `{"strictJsonSchema":false,"store":false,"stream":true,"prompt_cache_key":"efferent","text":{"verbosity":"low"}}`,
    `{"strictJsonSchema":false,"store":false,"stream":true,"prompt_cache_key":"lane","text":{"verbosity":"low"},"reasoning":{"effort":"max","summary":"auto"}}`,
    `{"strictJsonSchema":false,"store":false,"stream":true,"prompt_cache_key":"efferent","text":{"verbosity":"low"},"reasoning":{"effort":"none","summary":"auto"}}`,
  ],
  anthropic: [`{"systemPrelude":null}`, `{"systemPrelude":null}`, `{"systemPrelude":null}`],
} as const

/** A credential for every built-in provider, in the catalog's order. */
const CREDENTIALS = new Map<string, Credential>([
  ["opencode", { type: "api_key", key: Redacted.make("secret") }],
  ["openai-codex", { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1, accountId: "account" }],
  ["openai", { type: "api_key", key: Redacted.make("secret") }],
  ["anthropic", { type: "api_key", key: Redacted.make("secret") }],
  ["google", { type: "api_key", key: Redacted.make("secret") }],
])

const SELECTIONS: ReadonlyArray<readonly [string, boolean, string, Family]> = [
  ...CATALOG.map(([selection, , images, efforts, family]) => [selection, images, efforts, family] as const),
  ...UNLISTED,
]

const providerOf = (selection: string): string => selection.slice(0, selection.indexOf(":"))

/** The selection's model, built with its provider's credential under one context. */
const built = (selection: string, context: (typeof CONTEXTS)[number], credential = CREDENTIALS.get(providerOf(selection))) =>
  Effect.fromOption(parseModelSelection(selection)).pipe(
    Effect.flatMap((parsed) => buildProvider(parsed, credential, Redacted.make("test-key"))),
    Effect.provideService(CurrentPromptCacheKey, context[0]),
    Effect.provideService(CurrentModelCallPolicy, context[1]),
  )

/** The settings the selection's descriptor records under one context (built and described in it), as JSON. */
const settingsOf = (selection: string, context: (typeof CONTEXTS)[number]) =>
  Effect.runPromise(Effect.scoped(built(selection, context).pipe(
    Effect.flatMap((model) => modelRequestDescriptorOf(model.svc)),
    Effect.flatMap(Effect.fromOption),
    Effect.map((descriptor) => JSON.stringify({ provider: descriptor.provider, model: descriptor.model, settings: JSON.stringify(descriptor.settings) })),
  )).pipe(
    Effect.provideService(CurrentPromptCacheKey, context[0]),
    Effect.provideService(CurrentModelCallPolicy, context[1]),
    Effect.provide(FetchHttpClient.layer),
  ))

describe("the built-in providers, pinned", () => {
  it("the catalog lists every built-in model with its label and input, in order", () => {
    expect(configuredModelCatalog(CREDENTIALS)).toEqual(CATALOG.map(([selection, label, images]) => ({
      selection,
      ...(label.length > 0 ? { label } : {}),
      provider: providerOf(selection),
      credential: CREDENTIALS.get(providerOf(selection))?.type ?? "local",
      input: images ? ["text", "image"] : ["text"],
    })))
  })

  it("each built-in selection, listed or not, reads images and takes efforts as pinned", () => {
    expect(SELECTIONS.map(([selection]) => [selection, imageInputFor(selection), reasoningEffortsFor(selection).join(",")]))
      .toEqual(SELECTIONS.map(([selection, images, efforts]) => [selection, images, efforts]))
    expect(["local:llama3.1:8b", "nonsense", "opencode:", "openai"].map((selection) => [imageInputFor(selection), reasoningEffortsFor(selection)]))
      .toEqual([[false, []], [false, []], [false, []], [false, []]])
  })

  it("each built-in selection's descriptor records its family's settings in every context", async () => {
    const actual = await Promise.all(CONTEXTS.map((context) => Promise.all(SELECTIONS.map(([selection]) => settingsOf(selection, context)))))
    expect(actual).toEqual(CONTEXTS.map((_, index) => SELECTIONS.map(([selection, , , family]) =>
      JSON.stringify({ provider: providerOf(selection), model: selection.slice(selection.indexOf(":") + 1), settings: SETTINGS[family][index] }))))
  })

  it("each built model reads images as its selection does; only the Anthropic subscription prepends the Claude Code block", async () => {
    const flags = await Effect.runPromise(Effect.scoped(Effect.forEach(SELECTIONS, ([selection]) =>
      built(selection, CONTEXTS[0]!).pipe(Effect.map((model) => [selection, model.images, model.prependClaudeCode] as const)), { concurrency: 1 })).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(flags).toEqual(SELECTIONS.map(([selection, images]) => [selection, images, false]))
    const subscription = await Effect.runPromise(Effect.scoped(built("anthropic:claude-sonnet-5", CONTEXTS[0]!, { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1 }).pipe(
      Effect.flatMap((model) => Effect.map(modelRequestDescriptorOf(model.svc), (descriptor) => [model.prependClaudeCode, Option.map(descriptor, (value) => value.settings)] as const)),
    )).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(subscription).toEqual([true, Option.some({ systemPrelude: CLAUDE_CODE_SYSTEM })])
  })

  it("each route sends to its URL through its client", async () => {
    const sent = (selection: string) => {
      const urls: Array<string> = []
      const fetch = ((url: unknown) => {
        urls.push(url instanceof Request ? url.url : String(url))
        return Promise.resolve(Response.json({ error: { type: "invalid_request_error", message: "recorded" } }, { status: 400 }))
      }) as typeof globalThis.fetch
      return Effect.runPromise(Effect.scoped(built(selection, CONTEXTS[0]!).pipe(
        Effect.flatMap((model) => Effect.flip(model.svc.generateText({ prompt: "hi" }))),
        Effect.map((error) => [selection, urls, AiError.isAiError(error) ? error.module : "not an AiError"] as const),
      )).pipe(
        Effect.provideService(ModelsTransport, ModelsTransport.of({ fetch })),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ))
    }
    expect(await Promise.all(["opencode:glm-5.2", "google:gemini-3-flash", "opencode:gpt-5.6-luna", "openai:gpt-5.5", "anthropic:claude-sonnet-5"].map(sent))).toEqual([
      ["opencode:glm-5.2", ["https://opencode.ai/zen/go/v1/chat/completions"], "OpenCode"],
      ["google:gemini-3-flash", ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"], "Google"],
      ["opencode:gpt-5.6-luna", ["https://opencode.ai/zen/v1/responses"], "OpenAiClient"],
      ["openai:gpt-5.5", ["https://api.openai.com/v1/responses"], "OpenAiClient"],
      ["anthropic:claude-sonnet-5", ["https://api.anthropic.com/v1/messages?beta=true"], "AnthropicClient"],
    ])
  })

  it("a built-in provider without its key, and the subscription without its sign-in, fail with the provider's AuthError", async () => {
    const failure = (selection: string, credential: Credential | undefined) =>
      Effect.runPromise(Effect.scoped(Effect.fromOption(parseModelSelection(selection)).pipe(
        Effect.flatMap((parsed) => buildProvider(parsed, credential, undefined)),
        Effect.flip,
        Effect.map((error) => [error._tag, Reflect.get(error, "provider"), Reflect.get(error, "message")]),
      )).pipe(Effect.provide(FetchHttpClient.layer)))
    const missing = (provider: string) => [
      "AuthError", provider,
      `no credential for ${provider} — sign in through the AuthStore (storage "local" keeps it in ~/.efferent/runtime/auth.json), or give the models plugin one in credentials or credentialEnv (storage "memory")`,
    ]
    expect(await Promise.all(["opencode:glm-5.2", "opencode:gpt-5.5", "google:gemini-3-flash", "anthropic:claude-sonnet-5", "openai:gpt-5.5", "openai-codex:gpt-5.5"]
      .map((selection) => failure(selection, CREDENTIALS.get(providerOf(selection))))))
      .toEqual(["opencode", "opencode", "google", "anthropic", "openai", "openai-codex"].map(missing))
  })
})

describe("the profile table", () => {
  it("a provider that is not built in, an object's own key included, has no profile and lists no models", () => {
    expect(["ollama", "toString", "constructor", "__proto__"].map((provider) => Option.isNone(profileOf(provider)))).toEqual([true, true, true, true])
    expect(configuredModelCatalog(new Map<string, Credential>([["toString", { type: "api_key", key: Redacted.make("secret") }], ["ollama", { type: "local", baseUrl: "http://127.0.0.1:1/v1" }]]))).toEqual([])
  })

  it("a listed model's profile is its family's: the table's catalog and its rule agree", () => {
    expect(Object.values(PROVIDER_PROFILES).flatMap((profile) => profile.models.map((model) => [model, profile.modelOf(model.id)])))
      .toEqual(Object.values(PROVIDER_PROFILES).flatMap((profile) => profile.models.map((model) => [model, model])))
    expect(modelProfileOf("openai-codex:gpt-5.3-codex-spark")).toEqual(Option.some({ id: "gpt-5.3-codex-spark", images: false, efforts: ["low", "medium", "high", "xhigh"], bindsThinking: false }))
  })

  it("Claude binds thinking to the conversation from Fable 5.1 and Opus, Sonnet and Haiku 5.5, every later version and dated id included; no other model does", () => {
    const binds = (selection: string) => Option.match(modelProfileOf(selection), { onNone: () => "none", onSome: (profile) => profile.bindsThinking })
    expect([
      "anthropic:claude-fable-5-1", "anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5",
      "anthropic:claude-opus-5-5-20261001", "anthropic:claude-fable-5-2", "anthropic:claude-sonnet-6", "anthropic:claude-opus-6-1",
    ].map(binds)).toEqual([true, true, true, true, true, true, true, true])
    expect([
      "anthropic:claude-fable-5", "anthropic:claude-opus-4-8", "anthropic:claude-sonnet-5", "anthropic:claude-haiku-4-5", "anthropic:claude-haiku-4-5-20251001",
      "anthropic:claude-opus-5", "anthropic:claude-mythos-5-1", "openai:gpt-5.5", "openai-codex:gpt-5.6-sol", "opencode:glm-5.2", "google:gemini-3.1-pro",
    ].map(binds)).toEqual([false, false, false, false, false, false, false, false, false, false, false])
  })
})
