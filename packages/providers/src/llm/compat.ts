import { AiError, LanguageModel, Tool } from "@effect/ai"
import type { Prompt } from "@effect/ai"
import { Effect, Option, Stream } from "effect"

/**
 * A generic OpenAI-compatible `/chat/completions` `LanguageModel` over raw
 * `fetch`. The official `@effect/ai-openai` client targets api.openai.com;
 * gateways like OpenCode's speak the same protocol at a different base URL
 * with a Bearer key, so this client is parameterized by `chatUrl` + `apiKey`.
 *
 * v1 is deliberately NON-streaming (`stream: false`): the engine's loop
 * consumes whole turns via `generateText`, so SSE assembly buys nothing yet.
 * `streamText` fails with a clear error until a driver needs it.
 */

type Json = Record<string, unknown>

export interface CompatConfig {
  /** Module name for `AiError` provenance (e.g. "OpenCode"). */
  readonly moduleName: string
  /** Full chat-completions endpoint. */
  readonly chatUrl: string
  /** Bearer key (already resolved from the AuthStore). */
  readonly apiKey: string
  /** Provider-native model id. */
  readonly model: string
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

const aiUnknown = (moduleName: string, method: string, e: unknown): AiError.UnknownError =>
  new AiError.UnknownError({
    module: moduleName,
    method,
    description: String(e),
    cause: e,
  })

const requestInfo = (chatUrl: string) => ({
  method: "POST" as const,
  url: chatUrl,
  urlParams: [] as Array<[string, string]>,
  hash: Option.none<string>(),
  headers: { "content-type": "application/json" },
})

/** Decoded `Prompt` messages → chat-completions message objects. */
export const toChatMessages = (prompt: Prompt.Prompt): ReadonlyArray<Json> =>
  prompt.content.flatMap((message): ReadonlyArray<Json> => {
    if (message.role === "system") {
      return [{ role: "system", content: message.content }]
    }
    if (message.role === "user") {
      const text = message.content
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("")
      return [{ role: "user", content: text }]
    }
    if (message.role === "assistant") {
      const text = message.content
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("")
      const toolCalls = message.content.flatMap((p) =>
        p.type === "tool-call"
          ? [
              {
                id: p.id,
                type: "function" as const,
                function: { name: p.name, arguments: JSON.stringify(p.params ?? {}) },
              },
            ]
          : [],
      )
      return [
        {
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      ]
    }
    // tool: one chat message per result part, keyed by the originating call id.
    return message.content.flatMap((p) =>
      p.type === "tool-result"
        ? [
            {
              role: "tool",
              tool_call_id: p.id,
              content:
                typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? null),
            },
          ]
        : [],
    )
  })

/** User-defined tools → chat-completions function declarations (empty when
 *  the request carries none — the caller omits the `tools` key entirely). */
export const toChatTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<Json> =>
  tools.flatMap((tool) =>
    Tool.isUserDefined(tool)
      ? [
          {
            type: "function" as const,
            function: {
              name: tool.name,
              description: Tool.getDescription(tool as never),
              parameters: Tool.getJsonSchema(tool as never),
            },
          },
        ]
      : [],
  )

const toToolChoice = (choice: unknown): unknown => {
  if (choice === "none" || choice === "required") return choice
  if (typeof choice === "object" && choice !== null && "tool" in choice) {
    return {
      type: "function" as const,
      function: { name: (choice as { tool: string }).tool },
    }
  }
  return "auto"
}

/**
 * FORCE thinking on the families that think adaptively. Live forensics
 * (2026-07-09): kimi-k2.7-code skipped thinking on 24 turns of one forge run
 * and emitted degenerate skeleton tool calls (write_file with an EMPTY body,
 * 24 output tokens, finish "tool-calls") on exactly those turns — the
 * no-think ↔ empty-call correlation was 24/24. Deepseek-style families take
 * `thinking: {type: "enabled"}`; qwen takes `enable_thinking`. Disabling is
 * never sent (kimi-k2.7+ rejects it outright); unknown families get nothing.
 */
export const thinkingParams = (model: string): Record<string, unknown> => {
  // The CODE variants get HIGH effort on top — live-probed on kimi-k2.7-code:
  // enabled alone thought 103 tokens, enabled + reasoning_effort:"high"
  // thought 398 on the same prompt (accepted, no 400). Coding turns trade
  // latency for correctness; the interactive/fast tiers stay on plain
  // enabled.
  if (/kimi-k2[\w.]*-code/i.test(model)) {
    return { thinking: { type: "enabled" }, reasoning_effort: "high" }
  }
  if (/kimi-k2|deepseek/i.test(model)) return { thinking: { type: "enabled" } }
  if (/qwen/i.test(model)) return { enable_thinking: true }
  return {}
}

interface ChatCompletion {
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string
    readonly message?: {
      readonly content?: string | null
      /** DeepSeek-native vocabulary (kimi-k2.7-code, deepseek serve this). */
      readonly reasoning_content?: string | null
      /** OpenRouter-style vocabulary (kimi-k2.6 via Moonshot serves this). */
      readonly reasoning?: string | null
      readonly tool_calls?: ReadonlyArray<{
        readonly id?: string
        readonly function?: { readonly name?: string; readonly arguments?: string }
      }>
    }
  }>
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
    readonly total_tokens?: number
    readonly prompt_cache_hit_tokens?: number
    readonly cached_tokens?: number
    readonly prompt_tokens_details?: { readonly cached_tokens?: number }
  }
}

const finishReason = (raw: string | undefined): string => {
  if (raw === "tool_calls") return "tool-calls"
  if (raw === "length") return "length"
  if (raw === "content_filter") return "content-filter"
  return "stop"
}

/** Parse one non-streaming completion into `@effect/ai` encoded parts. */
export const fromChatCompletion = (
  moduleName: string,
  body: ChatCompletion,
): Effect.Effect<ReadonlyArray<unknown>, AiError.AiError> =>
  Effect.gen(function* () {
    const choice = body.choices?.[0]
    if (choice === undefined) {
      return yield* Effect.fail(
        new AiError.MalformedOutput({
          module: moduleName,
          method: "generateText",
          description: "the completion carried no choices",
        }),
      )
    }
    const message = choice.message ?? {}
    // The gateway fronts multiple upstreams with two reasoning vocabularies —
    // models think by DEFAULT (no request param), so missing either field
    // silently drops the thinking (live-caught on kimi-k2.6).
    const reasoning = message.reasoning_content ?? message.reasoning
    const text = message.content
    const toolCalls = yield* Effect.forEach(message.tool_calls ?? [], (tc) =>
      Effect.try({
        try: () => ({
          type: "tool-call" as const,
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          params: JSON.parse(tc.function?.arguments ?? "{}") as unknown,
        }),
        catch: () =>
          new AiError.MalformedOutput({
            module: moduleName,
            method: "generateText",
            description: `tool call ${tc.function?.name ?? "?"} carried unparseable JSON arguments`,
          }),
      }),
    )
    const usage = body.usage ?? {}
    const cached =
      usage.prompt_cache_hit_tokens ??
      usage.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0
    return [
      ...(reasoning !== null && reasoning !== undefined && reasoning.length > 0
        ? [{ type: "reasoning", text: reasoning }]
        : []),
      ...(text !== null && text !== undefined && text.length > 0
        ? [{ type: "text", text }]
        : []),
      ...toolCalls,
      {
        type: "finish",
        reason: toolCalls.length > 0 ? "tool-calls" : finishReason(choice.finish_reason),
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          cachedInputTokens: cached,
        },
      },
    ]
  })

export const makeCompatLanguageModel = (
  config: CompatConfig,
): Effect.Effect<LanguageModel.Service> => {
  const doFetch = config.fetchImpl ?? fetch
  return LanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        const tools = toChatTools(options.tools)
        const body: Json = {
          model: config.model,
          messages: toChatMessages(options.prompt),
          stream: false,
          ...thinkingParams(config.model),
          ...(tools.length > 0
            ? { tools, tool_choice: toToolChoice(options.toolChoice) }
            : {}),
        }
        const res = yield* Effect.tryPromise({
          try: () =>
            doFetch(config.chatUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify(body),
            }),
          catch: (e) => aiUnknown(config.moduleName, "generateText", e),
        })
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => aiUnknown(config.moduleName, "generateText", e),
        })
        if (!res.ok) {
          const headers: Record<string, string> = {}
          res.headers.forEach((value, headerName) => {
            headers[headerName] = value
          })
          return yield* Effect.fail(
            new AiError.HttpResponseError({
              module: config.moduleName,
              method: "generateText",
              reason: "StatusCode",
              request: requestInfo(config.chatUrl),
              response: { status: res.status, headers },
              description: text.slice(0, 500),
            }),
          )
        }
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text) as ChatCompletion,
          catch: () =>
            new AiError.MalformedOutput({
              module: config.moduleName,
              method: "generateText",
              description: `the completion body was not JSON: ${text.slice(0, 200)}`,
            }),
        })
        return (yield* fromChatCompletion(config.moduleName, parsed)) as never
      }),
    streamText: () =>
      Stream.fail(
        aiUnknown(
          config.moduleName,
          "streamText",
          "streaming is not implemented on the new line yet — use generateText",
        ),
      ) as never,
  })
}
