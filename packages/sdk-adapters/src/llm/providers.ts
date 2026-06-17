import { LanguageModel, Prompt } from "@effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import type {
  AnthropicThinkingEffort,
  Credential,
  GeminiThinkingLevel,
  ModelSelection,
  OpenAiReasoningEffort,
  OpenCodeThinkingMode,
  Settings,
} from "@efferent/sdk-core"
import { Effect, Redacted, type Scope } from "effect"
import {
  ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_SYSTEM,
} from "../auth/oauth/anthropic.js"
import { makeOpenAiCodexLanguageModel } from "./openAiCodex.js"
import { makeOpenCodeLanguageModel } from "./openCode.js"
import { makeOllamaLanguageModel, OLLAMA_DEFAULT_BASE_URL } from "./ollama.js"

// Anthropic OAuth authenticates as a subscription: Bearer + Claude Code beta
// flags, never `x-api-key`.
const anthropicOAuthTransform =
  (access: Redacted.Redacted) =>
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

const claudeCodePrompt = Prompt.make([
  { role: "system", content: CLAUDE_CODE_SYSTEM },
])

export const prependClaudeCode = (options: unknown): unknown => ({
  ...(options as Record<string, unknown>),
  prompt: Prompt.merge(
    claudeCodePrompt,
    Prompt.make((options as { prompt: Prompt.RawInput }).prompt),
  ),
})

/**
 * Anthropic prompt caching is OPT-IN per request: with no `cache_control`
 * breakpoints the API caches NOTHING — every turn re-reads the whole
 * conversation at full input price. (OpenAI caches prefixes automatically;
 * Gemini caches implicitly; Anthropic alone requires explicit markers.)
 *
 * We stamp ephemeral breakpoints (the documented conversational pattern) on:
 * - the **last system message** — one breakpoint covering tools + system,
 *   the static prefix; and
 * - the **last two non-system messages** — the moving boundary: last turn's
 *   marker is this turn's read hit, the newest message writes the next entry.
 *
 * `cache_control` placement is not part of Anthropic's content hash, so the
 * markers moving forward each turn never invalidates earlier prefixes. A
 * message that already carries an explicit `cacheControl` (e.g. round-tripped
 * via providerOptions) is left alone; other anthropic options are merged, not
 * replaced. Applied by the router only for `provider === "anthropic"` — the
 * one-shot helper tiers (UtilityLlm, web search) never pay the +25% cache
 * write premium for prompts that are never reused.
 */
export const withAnthropicCacheBreakpoints = (options: unknown): unknown => {
  const prompt = Prompt.make((options as { prompt: Prompt.RawInput }).prompt)
  const messages = prompt.content
  if (messages.length === 0) return options

  const stampIdx = new Set<number>()
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "system") {
      stampIdx.add(i)
      break
    }
  }
  let tail = 0
  for (let i = messages.length - 1; i >= 0 && tail < 2; i--) {
    if (messages[i]!.role === "system") continue
    stampIdx.add(i)
    tail++
  }

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

export interface ProviderLanguageModel {
  readonly svc: LanguageModel.Service
  readonly prependClaudeCode: boolean
}

const anthropicThinkingConfig = (
  effort: AnthropicThinkingEffort | undefined,
): { readonly type: "enabled"; readonly budget_tokens: number } | { readonly type: "disabled" } | undefined => {
  switch (effort) {
    case undefined:
      return undefined
    case "off":
      return { type: "disabled" }
    case "low":
      return { type: "enabled", budget_tokens: 1_024 }
    case "medium":
      return { type: "enabled", budget_tokens: 2_048 }
    case "high":
      return { type: "enabled", budget_tokens: 3_072 }
  }
}

const googleThinkingConfig = (
  model: string,
  level: GeminiThinkingLevel | undefined,
): {
  readonly includeThoughts?: boolean
  readonly thinkingBudget?: number
  readonly thinkingLevel?: "LOW" | "MEDIUM" | "HIGH"
} | undefined => {
  if (level === undefined) return undefined
  if (level === "off") return { thinkingBudget: 0 }

  // Gemini 3 added a discrete thinkingLevel knob; earlier thinking-capable
  // Gemini models use token budgets.
  if (/gemini-3/i.test(model)) {
    switch (level) {
      case "minimal":
      case "low":
        return { includeThoughts: true, thinkingLevel: "LOW" }
      case "medium":
        return { includeThoughts: true, thinkingLevel: "MEDIUM" }
      case "high":
        return { includeThoughts: true, thinkingLevel: "HIGH" }
    }
  }

  switch (level) {
    case "minimal":
      return { includeThoughts: true, thinkingBudget: 512 }
    case "low":
      return { includeThoughts: true, thinkingBudget: 1_024 }
    case "medium":
      return { includeThoughts: true, thinkingBudget: 4_096 }
    case "high":
      return { includeThoughts: true, thinkingBudget: 8_192 }
  }
}

const supportsOpenAiReasoning = (model: string): boolean =>
  /^gpt-5/i.test(model) || /^o\d/i.test(model)

const openAiReasoningConfig = (
  model: string,
  effort: OpenAiReasoningEffort | undefined,
): { readonly effort: OpenAiReasoningEffort; readonly summary: "auto" } | undefined =>
  effort === undefined || !supportsOpenAiReasoning(model)
    ? undefined
    : { effort, summary: "auto" }

export const makeProviderLanguageModel = (
  sel: ModelSelection,
  key: Redacted.Redacted | undefined,
  cred: Credential | undefined,
  settings: Settings,
): Effect.Effect<
  ProviderLanguageModel,
  never,
  HttpClient.HttpClient | Scope.Scope
> => {
  const oauth = cred?.type === "oauth"
  switch (sel.provider) {
    case "google":
      return GoogleClient.make({ apiKey: key }).pipe(
        Effect.flatMap((client) =>
          GoogleLanguageModel.make({
            model: sel.modelId,
            config: {
              toolConfig: {},
              ...(googleThinkingConfig(sel.modelId, settings.geminiThinkingLevel) !== undefined
                ? { generationConfig: { thinkingConfig: googleThinkingConfig(sel.modelId, settings.geminiThinkingLevel) } }
                : {}),
            },
          }).pipe(
            Effect.provideService(GoogleClient.GoogleClient, client),
          ),
        ),
        Effect.map((svc) => ({ svc, prependClaudeCode: false })),
      )
    case "anthropic":
      return (
        oauth && key !== undefined
          ? AnthropicClient.make({
              apiKey: undefined,
              transformClient: anthropicOAuthTransform(key),
            })
          : AnthropicClient.make({ apiKey: key })
      ).pipe(
        Effect.flatMap((client) =>
          AnthropicLanguageModel.make({
            model: sel.modelId,
            config: {
              ...(anthropicThinkingConfig(settings.anthropicThinkingEffort) !== undefined
                ? { thinking: anthropicThinkingConfig(settings.anthropicThinkingEffort) }
                : {}),
            },
          }).pipe(
            Effect.provideService(AnthropicClient.AnthropicClient, client),
          ),
        ),
        Effect.map((svc) => ({ svc, prependClaudeCode: oauth })),
      )
    case "opencode":
      return makeOpenCodeLanguageModel(
        sel.modelId,
        key !== undefined ? Redacted.value(key) : "",
        settings.openCodeThinkingMode,
      ).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false })))
    case "openai":
      if (oauth && key !== undefined) {
        return makeOpenAiCodexLanguageModel(sel.modelId, {
          access: Redacted.value(key),
          ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}),
          installationId: cred.installationId ?? "efferent",
          ...(settings.openAiReasoningEffort !== undefined
            ? { reasoningEffort: settings.openAiReasoningEffort }
            : {}),
        }).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false })))
      }
      return OpenAiClient.make({ apiKey: key }).pipe(
        Effect.flatMap((client) =>
          OpenAiLanguageModel.make({
            model: sel.modelId,
            config: {
              prompt_cache_key: "efferent",
              ...(openAiReasoningConfig(sel.modelId, settings.openAiReasoningEffort) !== undefined
                ? { reasoning: openAiReasoningConfig(sel.modelId, settings.openAiReasoningEffort) }
                : {}),
            },
          }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
        ),
        Effect.map((svc) => ({ svc, prependClaudeCode: false })),
      )
    case "ollama": {
      const baseUrl =
        cred?.type === "local" ? (cred.baseUrl ?? OLLAMA_DEFAULT_BASE_URL) : OLLAMA_DEFAULT_BASE_URL
      return makeOllamaLanguageModel(baseUrl, sel.modelId).pipe(
        Effect.map((svc) => ({ svc, prependClaudeCode: false })),
      )
    }
  }
}
