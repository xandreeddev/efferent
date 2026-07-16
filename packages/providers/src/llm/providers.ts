import { LanguageModel, Prompt } from "@effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, FiberRef, Option, Redacted } from "effect"
import type { Scope } from "effect"
import { AuthError, CurrentModelCallPolicy, CurrentPromptCacheKey } from "@xandreed/engine"
import type { Credential, ModelSelection } from "@xandreed/engine"
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM } from "../auth/anthropicOAuth.js"
import { makeCompatLanguageModel } from "./compat.js"
import { makeOpenAiCodexLanguageModel } from "./openAiCodex.js"
import { openAiCodexAccountId } from "../auth/openAiCodexOAuth.js"

/**
 * Per-provider `LanguageModel.Service` construction. Built PER REQUEST from a
 * freshly-resolved key (never captured at layer build), so a credential or
 * model switch applies on the next call.
 *
 * v1 providers: opencode (OpenAI-compatible gateway — the default), google,
 * anthropic (api key or subscription OAuth), openai (api key). OpenAI-OAuth
 * (Codex) and ollama are deferred until an agent needs them.
 */

export const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
/** OpenCode serves GPT models through the OpenAI Responses protocol. */
export const OPENCODE_RESPONSES_API_URL = "https://opencode.ai/zen/v1"

/** Pure protocol routing decision; provider details stay inside this adapter. */
export const usesOpenCodeResponses = (modelId: string): boolean => /^gpt-/i.test(modelId)

export interface BuiltProvider {
  readonly svc: LanguageModel.Service
  /** Anthropic subscription auth requires the Claude Code system block first. */
  readonly prependClaudeCode: boolean
}

// Anthropic OAuth authenticates as a subscription: Bearer + Claude Code beta
// flags, never `x-api-key`.
const anthropicOAuthTransform =
  (access: Redacted.Redacted<string>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${Redacted.value(access)}`,
            "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          }),
        ),
      ),
    )

const claudeCodePrompt = Prompt.make([{ role: "system", content: CLAUDE_CODE_SYSTEM }])

/** Prepend the Claude Code system block (subscription-auth requirement). */
export const prependClaudeCode = (options: unknown): unknown => ({
  ...(options as Record<string, unknown>),
  prompt: Prompt.merge(
    claudeCodePrompt,
    Prompt.make((options as { prompt: Prompt.RawInput }).prompt),
  ),
})

/**
 * Anthropic prompt caching is OPT-IN per request: stamp ephemeral
 * `cache_control` breakpoints on the last system message + the last two
 * non-system messages. Marker placement is not part of Anthropic's content
 * hash, so the markers moving forward each turn never invalidates earlier
 * prefixes. Messages already carrying an explicit `cacheControl` are left
 * alone.
 */
export const withAnthropicCacheBreakpoints = (options: unknown): unknown => {
  const prompt = Prompt.make((options as { prompt: Prompt.RawInput }).prompt)
  const messages = prompt.content
  if (messages.length === 0) return options

  const lastSystem = messages.reduce(
    (acc: number, m, i) => (m.role === "system" ? i : acc),
    -1,
  )
  const nonSystem = messages.flatMap((m, i) => (m.role === "system" ? [] : [i]))
  const stampIdx = new Set([
    ...(lastSystem >= 0 ? [lastSystem] : []),
    ...nonSystem.slice(-2),
  ])

  const stamped = messages.map((msg, i) => {
    if (!stampIdx.has(i)) return msg
    const anthropic = (msg.options["anthropic"] ?? {}) as Record<string, unknown>
    if (anthropic["cacheControl"] !== undefined) return msg
    return Prompt.makeMessage(msg.role, {
      ...msg,
      options: {
        ...msg.options,
        anthropic: { ...anthropic, cacheControl: { type: "ephemeral" } },
      },
    } as never)
  })
  return {
    ...(options as Record<string, unknown>),
    prompt: Prompt.fromMessages(stamped),
  }
}

const missingKey = (selection: ModelSelection): AuthError =>
  new AuthError({
    provider: selection.provider,
    message: `no credential for ${selection.provider} — add one to ~/.efferent/auth.json`,
  })

export const buildProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> => {
  const oauth = credential?.type === "oauth"
  if (selection.provider === "opencode") {
    if (key === undefined) return Effect.fail(missingKey(selection))
    if (usesOpenCodeResponses(selection.modelId)) {
      return Effect.all({
        cacheKey: FiberRef.get(CurrentPromptCacheKey),
        policy: FiberRef.get(CurrentModelCallPolicy),
      }).pipe(
        Effect.flatMap(({ cacheKey, policy }) =>
          OpenAiClient.make({ apiKey: key, apiUrl: OPENCODE_RESPONSES_API_URL }).pipe(
            Effect.flatMap((client) =>
              OpenAiLanguageModel.make({
                model: selection.modelId,
                config: {
                  // UI tools contain genuinely optional fields. OpenAI strict
                  // schemas require every property, so use normal function
                  // calling and let Effect decode the domain schema.
                  strict: false,
                  prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent"),
                  ...Option.match(policy, {
                    onNone: () => ({}),
                    onSome: (value) => ({
                      ...(value.maxOutputTokens === undefined
                        ? {}
                        : { max_output_tokens: value.maxOutputTokens }),
                      reasoning: {
                        // The public-API SDK union has no none/xhigh/max —
                        // clamp to the nearest supported value (only the
                        // codex dialect is probe-verified for `none`).
                        effort: value.effort === "xhigh" || value.effort === "max"
                          ? "high"
                          : value.effort === "none"
                            ? "low"
                            : value.effort,
                      },
                    }),
                  }),
                },
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
            ),
            Effect.map((svc) => ({ svc, prependClaudeCode: false })),
          ),
        ),
      )
    }
    return makeCompatLanguageModel({
      moduleName: "OpenCode",
      chatUrl: OPENCODE_CHAT_URL,
      apiKey: Redacted.value(key),
      model: selection.modelId,
    }).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false })))
  }
  if (selection.provider === "google") {
    return key === undefined
      ? Effect.fail(missingKey(selection))
      : GoogleClient.make({ apiKey: key }).pipe(
          Effect.flatMap((client) =>
            GoogleLanguageModel.make({
              model: selection.modelId,
              config: { toolConfig: {} },
            }).pipe(Effect.provideService(GoogleClient.GoogleClient, client)),
          ),
          Effect.map((svc) => ({ svc, prependClaudeCode: false })),
        )
  }
  if (selection.provider === "anthropic") {
    if (key === undefined) return Effect.fail(missingKey(selection))
    return (
      oauth
        ? AnthropicClient.make({
            apiKey: undefined,
            transformClient: anthropicOAuthTransform(key),
          })
        : AnthropicClient.make({ apiKey: key })
    ).pipe(
      Effect.flatMap((client) =>
        AnthropicLanguageModel.make({ model: selection.modelId }).pipe(
          Effect.provideService(AnthropicClient.AnthropicClient, client),
        ),
      ),
      Effect.map((svc) => ({ svc, prependClaudeCode: oauth })),
    )
  }
  if (selection.provider === "openai-codex") {
    if (key === undefined || credential?.type !== "oauth") return Effect.fail(missingKey(selection))
    const accountId = Option.orElse(Option.fromNullable(credential.accountId), () => openAiCodexAccountId(Redacted.value(key)))
    if (Option.isNone(accountId)) {
      return Effect.fail(new AuthError({ provider: selection.provider, message: "the OpenAI subscription token has no ChatGPT account id — sign in again with Smith :login" }))
    }
    return makeOpenAiCodexLanguageModel({ model: selection.modelId, accessToken: key, accountId: accountId.value }).pipe(
      Effect.map((svc) => ({ svc, prependClaudeCode: false })),
    )
  }
  if (selection.provider === "openai") {
    return key === undefined
      ? Effect.fail(missingKey(selection))
      : Effect.flatMap(FiberRef.get(CurrentPromptCacheKey), (cacheKey) =>
          OpenAiClient.make({ apiKey: key }).pipe(
            Effect.flatMap((client) =>
              OpenAiLanguageModel.make({
                model: selection.modelId,
                // The per-conversation cache lane, same as the compat path —
                // one shared constant lane cross-evicts between conversations
                // (construction happens per call, inside the run's fiber, so
                // the FiberRef is set here).
                config: {
                  prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent"),
                },
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
            ),
            Effect.map((svc) => ({ svc, prependClaudeCode: false })),
          ),
        )
  }
  return Effect.fail(
    new AuthError({
      provider: selection.provider,
      message: `provider "${selection.provider}" is not wired on the new line (v1: opencode, google, anthropic, openai, openai-codex)`,
    }),
  )
}
