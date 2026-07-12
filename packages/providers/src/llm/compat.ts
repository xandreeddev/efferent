import { AiError, LanguageModel, Tool } from "@effect/ai"
import type { Prompt } from "@effect/ai"
import { Effect, FiberRef, Option, Stream } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey } from "@xandreed/engine"
import { finishReasonFromWire, sseStreamParts, usageFromCompletion } from "./sse.js"
import type { CompletionUsage } from "./sse.js"

/**
 * A generic OpenAI-compatible `/chat/completions` `LanguageModel` over raw
 * `fetch`. The official `@effect/ai-openai` client targets api.openai.com;
 * gateways like OpenCode's speak the same protocol at a different base URL
 * with a Bearer key, so this client is parameterized by `chatUrl` + `apiKey`.
 *
 * `generateText` consumes whole turns (`stream: false`); `streamText` runs
 * the same request with `stream: true` through the pure SSE state machine in
 * `sse.ts`. Errors BEFORE any stream part surface with the same taxonomy as
 * `generateText` — that boundary is what the retry gate (router) keys on.
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
  readonly usage?: CompletionUsage
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
        reason:
          toolCalls.length > 0 ? "tool-calls" : finishReasonFromWire(choice.finish_reason),
        usage: usageFromCompletion(body.usage),
      },
    ]
  })

/** The one request shape both paths send; only `stream` differs (streaming
 *  additionally asks the gateway to attach usage to the final chunk). The
 *  engine's per-conversation cache identity rides as `prompt_cache_key` —
 *  one conversation, one server-side cache lane (parallel sessions stop
 *  evicting each other's prefixes); absent when no run stamped one. */
const chatRequestBody = (
  config: CompatConfig,
  options: { readonly prompt: Prompt.Prompt; readonly tools: ReadonlyArray<Tool.Any>; readonly toolChoice?: unknown },
  streaming: boolean,
): Effect.Effect<Json> =>
  Effect.all({ cacheKey: FiberRef.get(CurrentPromptCacheKey), policy: FiberRef.get(CurrentModelCallPolicy) }).pipe(
    Effect.map(({ cacheKey, policy }) => {
      const tools = toChatTools(options.tools)
      return {
        model: config.model,
        messages: toChatMessages(options.prompt),
        stream: streaming,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
        ...Option.match(cacheKey, {
          onNone: () => ({}),
          onSome: (key) => ({ prompt_cache_key: key }),
        }),
        ...thinkingParams(config.model),
        ...Option.match(policy, {
          onNone: () => ({}),
          onSome: (value) => ({
            ...(value.maxOutputTokens === undefined ? {} : { max_tokens: value.maxOutputTokens }),
            reasoning_effort: value.effort,
          }),
        }),
        ...(tools.length > 0 ? { tools, tool_choice: toToolChoice(options.toolChoice) } : {}),
      }
    }),
  )

const postChat = (
  config: CompatConfig,
  method: string,
  body: Json,
): Effect.Effect<Response, AiError.AiError> =>
  Effect.tryPromise({
    try: () =>
      (config.fetchImpl ?? fetch)(config.chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      }),
    catch: (e) => aiUnknown(config.moduleName, method, e),
  })

/** A non-OK status → `HttpResponseError` with the status + a body excerpt —
 *  identical taxonomy on both paths (the retry classifier reads it). */
const failStatus = (
  config: CompatConfig,
  method: string,
  res: Response,
): Effect.Effect<never, AiError.AiError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => aiUnknown(config.moduleName, method, e),
    })
    // (forEach, not Object.fromEntries — this lib config's Headers type has
    // no entries(); the mutation is contained to this literal.)
    const headers: Record<string, string> = {}
    res.headers.forEach((value, headerName) => {
      headers[headerName] = value
    })
    return yield* Effect.fail(
      new AiError.HttpResponseError({
        module: config.moduleName,
        method,
        reason: "StatusCode",
        request: requestInfo(config.chatUrl),
        response: { status: res.status, headers },
        description: text.slice(0, 500),
      }),
    )
  })

export const makeCompatLanguageModel = (
  config: CompatConfig,
): Effect.Effect<LanguageModel.Service> =>
  LanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        const res = yield* postChat(
          config,
          "generateText",
          yield* chatRequestBody(config, options, false),
        )
        if (!res.ok) {
          return yield* failStatus(config, "generateText", res)
        }
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => aiUnknown(config.moduleName, "generateText", e),
        })
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
    streamText: (options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const res = yield* postChat(
            config,
            "streamText",
            yield* chatRequestBody(config, options, true),
          )
          if (!res.ok) {
            return yield* failStatus(config, "streamText", res)
          }
          const body = res.body
          if (body === null) {
            return yield* Effect.fail(
              new AiError.MalformedOutput({
                module: config.moduleName,
                method: "streamText",
                description: "the streaming response carried no body",
              }),
            )
          }
          return sseStreamParts({ moduleName: config.moduleName, body })
        }),
      ) as never,
  })
