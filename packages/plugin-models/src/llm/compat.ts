import { AiError, LanguageModel, Tool } from "effect/ai"
import type { Prompt } from "effect/ai"
import { Effect, Result, Option, Stream } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, describeModel, strictJsonSchema, toolParametersSchema } from "@xandreed/core"
import type { ModelCallPolicy } from "@xandreed/core"
import { finishReasonFromWire, sseStreamParts, usageFromCompletion } from "./sse.js"
import type { CompletionUsage } from "./sse.js"
import { makeOpenCodeRequestHeaders } from "./openCodeHeaders.adapter.js"

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

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null ? value as Json : {}

/** Gateways sometimes encode a semantic model/billing rejection behind an
 * HTTP status normally associated with auth. Preserve the provider meaning
 * so agents and evals do not diagnose "bad key" for an unsupported model. */
const semanticGatewayError = (
  moduleName: string,
  method: string,
  body: string,
  http: typeof AiError.HttpContext.Type,
): Option.Option<AiError.AiError> =>
  Option.flatMap(
    Option.fromNullishOr(Result.getOrUndefined(Result.try(() => JSON.parse(body) as unknown))),
    (decoded) => {
      const payload = record(decoded)
      const error = record(payload["error"])
      const type = typeof error["type"] === "string" ? error["type"] : typeof payload["type"] === "string" ? payload["type"] : ""
      const message = typeof error["message"] === "string" ? error["message"] : typeof payload["message"] === "string" ? payload["message"] : ""
      if (type === "MissingSessionID" || /requires global regions|select global.*privacy settings/i.test(message)) {
        return Option.some(AiError.make({
          module: moduleName, method,
          reason: new AiError.InvalidRequestError({
            description: `${message.replace(/^Upstream request failed:\s*/i, "")}\nProvider response: ${body.slice(0, 1000)}`,
            http,
          }),
        }))
      }
      if (type === "ModelError" || /model .*not supported/i.test(message)) {
        return Option.some(AiError.make({
          module: moduleName,
          method,
          reason: new AiError.InvalidRequestError({
            description: message.length > 0 ? message : "the selected model is not supported",
          }),
        }))
      }
      if (type === "CreditsError" || /insufficient (?:balance|credits)|usage limit|quota/i.test(message)) {
        return Option.some(AiError.make({
          module: moduleName,
          method,
          reason: new AiError.InvalidRequestError({
            description: `${message || "provider quota exhausted"}\nProvider response: ${body.slice(0, 1000)}`,
            http,
          }),
        }))
      }
      return Option.none()
    },
  )

export interface CompatConfig {
  /** Module name for `AiError` provenance (e.g. "OpenCode"). */
  readonly moduleName: string
  /** Full chat-completions endpoint. */
  readonly chatUrl: string
  /** Bearer key (already resolved from the AuthStore). */
  readonly apiKey: string
  /** Provider-native model id. */
  readonly model: string
  /** Host-selected thinking mode. Omit to retain family defaults. */
  readonly thinking?: "enabled" | "disabled"
  /** Gateway reasoning vocabulary, independent of provider-native thinking. */
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  readonly temperature?: number
  /** Send standard chat-completions fields only — no prompt-cache key,
   *  thinking defaults or call policy — for endpoints that reject the
   *  gateway extensions (Gemini's OpenAI-compatible API). */
  readonly standardOnly?: boolean
  /** Vercel normalizes reasoning and provider routing on its compatible API. */
  readonly gatewayDialect?: "vercel"
  readonly providerOrder?: ReadonlyArray<string>
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Host-owned admission (e.g. reserve a worst-case cost) before every call. */
  readonly beforeRequest?: (body: Readonly<Record<string, unknown>>) => Effect.Effect<void, AiError.AiError>
  /** Per-call accounting/resource boundary. Non-streaming responses are fully
   * buffered inside request so interruption also aborts body consumption. */
  readonly aroundRequest?: (body: Readonly<Record<string, unknown>>, request: Effect.Effect<Response, AiError.AiError>) => Effect.Effect<Response, AiError.AiError>
}

const redactCredential = (key: string, value: string): string =>
  key.length === 0 ? value : value.split(key).join("[redacted]")

const sensitiveResponseHeader = (name: string): boolean =>
  /^(?:authorization|proxy-authorization|cookie|set-cookie|(?:x-)?(?:api-key|auth-token|access-token|refresh-token)|x-vercel-protection-bypass|cf-access-jwt-assertion)$/i.test(name)

const aiUnknown = (moduleName: string, method: string, e: unknown, key = ""): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.UnknownError({ description: redactCredential(key, String(e)) }) })

const invalidOutput = (moduleName: string, method: string, description: string): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.InvalidOutputError({ description }) })

const requestInfo = (chatUrl: string) => ({
  method: "POST" as const,
  url: chatUrl,
  urlParams: [] as Array<[string, string]>,
  headers: { "content-type": "application/json" },
})

/** Decoded `Prompt` messages → chat-completions message objects. */
export const toChatMessages = (prompt: Prompt.Prompt, preserveReasoning: boolean | "vercel" = false): ReadonlyArray<Json> =>
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
      const reasoning = message.content
        .flatMap((part) => part.type === "reasoning" ? [part.text] : [])
        .join("")
      const reasoningDetails = message.content.flatMap((part) => {
        const details = record(part.options["vercel"])["reasoningDetails"]
        return Array.isArray(details) ? details : []
      })
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
          ...(preserveReasoning === "vercel"
            ? { reasoning, ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}) }
            : preserveReasoning ? { reasoning_content: reasoning } : {}),
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
              parameters: toolParametersSchema(tool as never),
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
      readonly reasoning_details?: ReadonlyArray<unknown>
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
      return yield* Effect.fail(invalidOutput(moduleName, "generateText", "the completion carried no choices"))
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
          invalidOutput(moduleName, "generateText", `tool call ${tc.function?.name ?? "?"} carried unparseable JSON arguments`),
      }),
    )
    return [
      ...((reasoning !== null && reasoning !== undefined && reasoning.length > 0) || (message.reasoning_details?.length ?? 0) > 0
        ? [{ type: "reasoning", text: reasoning ?? "", ...(message.reasoning_details === undefined ? {} : { metadata: { vercel: { reasoningDetails: message.reasoning_details } } }) }]
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

/** A request's public options, shared by the body and the model's descriptor:
 *  the sampling temperature (sent before the messages) and the gateway
 *  extensions (sent after them), as the wire has always ordered them. */
const vercelSettings = (config: CompatConfig, policy: Option.Option<ModelCallPolicy>): Json => {
  const effort = Option.orElse(Option.map(policy, (value) => value.effort), () => Option.fromNullishOr(config.reasoningEffort))
  return {
    ...(config.providerOrder === undefined ? {} : { providerOptions: { gateway: { order: config.providerOrder } } }),
    reasoning: {
      enabled: Option.match(effort, { onNone: () => config.thinking !== "disabled", onSome: (value) => value !== "none" }),
      ...Option.match(effort, { onNone: () => ({}), onSome: (value) => ({ effort: value }) }),
    },
    ...Option.match(policy, { onNone: () => ({}), onSome: (value) => value.maxOutputTokens === undefined ? {} : { max_tokens: value.maxOutputTokens } }),
  }
}

const requestSettings = (config: CompatConfig, cacheKey: Option.Option<string>, policy: Option.Option<ModelCallPolicy>): { readonly sampling: Json; readonly extensions: Json } => ({
  sampling: config.temperature === undefined ? {} : { temperature: config.temperature },
  extensions: config.standardOnly === true ? {} : config.gatewayDialect === "vercel" ? vercelSettings(config, policy) : {
    ...Option.match(cacheKey, { onNone: () => ({}), onSome: (key) => ({ prompt_cache_key: key }) }),
    ...(config.thinking === undefined ? thinkingParams(config.model) : { thinking: { type: config.thinking } }),
    ...(config.reasoningEffort === undefined ? {} : { reasoning: { effort: config.reasoningEffort } }),
    ...Option.match(policy, {
      onNone: () => ({}),
      onSome: (value) => ({
        ...(value.maxOutputTokens === undefined ? {} : { max_tokens: value.maxOutputTokens }),
        ...(config.thinking === "disabled" || config.reasoningEffort !== undefined ? {} : { reasoning_effort: value.effort }),
      }),
    }),
  },
})

/** The one request shape both paths send; only `stream` differs (streaming
 *  additionally asks the gateway to attach usage to the final chunk). The
 *  engine's per-conversation cache identity rides as `prompt_cache_key` —
 *  one conversation, one server-side cache lane (parallel sessions stop
 *  evicting each other's prefixes); absent when no run stamped one. */
const chatRequestBody = (
  config: CompatConfig,
  options: LanguageModel.ProviderOptions,
  streaming: boolean,
): Effect.Effect<Json> =>
  Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }).pipe(
    Effect.map(({ cacheKey, policy }) => {
      const tools = toChatTools(options.tools)
      const settings = requestSettings(config, cacheKey, policy)
      return {
        model: config.model,
        ...settings.sampling,
        // DeepSeek thinking-mode tool continuations require every prior
        // assistant's reasoning_content, including plain-text turns.
        messages: toChatMessages(options.prompt, config.gatewayDialect === "vercel" ? "vercel" : !config.standardOnly && /deepseek/i.test(config.model)),
        stream: streaming,
        ...(options.responseFormat.type === "json" ? { response_format: {
          type: "json_schema", json_schema: { name: options.responseFormat.objectName, strict: true, schema: strictJsonSchema(options.responseFormat.schema) },
        } } : {}),
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
        ...settings.extensions,
        ...(tools.length > 0 ? { tools, tool_choice: toToolChoice(options.toolChoice) } : {}),
      }
    }),
  )

const postChat = (
  config: CompatConfig,
  method: string,
  body: Json,
  buffered = false,
  routingHeaders: Effect.Effect<Readonly<Record<string, string>>> = Effect.succeed({}),
): Effect.Effect<Response, AiError.AiError> => {
  const request = routingHeaders.pipe(Effect.flatMap((headers) => (config.beforeRequest?.(body) ?? Effect.void).pipe(Effect.andThen(Effect.tryPromise({
    try: async (signal) => {
      const response = await (config.fetchImpl ?? fetch)(config.chatUrl, {
        signal,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      // Keep cancellation attached through non-streaming body consumption.
      return buffered ? new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers }) : response
    },
    catch: (e) => aiUnknown(config.moduleName, method, e, config.apiKey),
  })))))
  return config.aroundRequest === undefined ? request : config.aroundRequest(body, request)
}

/** A non-OK status → an `AiError` whose reason follows the status and keeps
 *  the response (status, headers) and a body excerpt — identical taxonomy on
 *  both paths (the retry classifier reads it). */
const failStatus = (
  config: CompatConfig,
  method: string,
  res: Response,
): Effect.Effect<never, AiError.AiError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => aiUnknown(config.moduleName, method, e, config.apiKey),
    }).pipe(Effect.map((value) => redactCredential(config.apiKey, value)))
    // (forEach, not Object.fromEntries — this lib config's Headers type has
    // no entries(); the mutation is contained to this literal.)
    const headers: Record<string, string> = {}
    res.headers.forEach((value, headerName) => {
      headers[headerName] = sensitiveResponseHeader(headerName) ? "[redacted]" : redactCredential(config.apiKey, value)
    })
    const semantic = semanticGatewayError(config.moduleName, method, text, { request: requestInfo(config.chatUrl), response: { status: res.status, headers }, body: text })
    if (Option.isSome(semantic)) return yield* Effect.fail(semantic.value)
    return yield* Effect.fail(
      AiError.make({
        module: config.moduleName,
        method,
        reason: AiError.reasonFromHttpStatus({
          status: res.status,
          http: { request: requestInfo(config.chatUrl), response: { status: res.status, headers }, body: text.slice(0, 500) },
          description: text.slice(0, 500),
        }),
      }),
    )
  })

export const makeCompatLanguageModel = (
  config: CompatConfig,
): Effect.Effect<LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
  const routingHeaders = config.moduleName === "OpenCode" ? yield* makeOpenCodeRequestHeaders : Effect.succeed<Readonly<Record<string, string>>>({})
  return yield* LanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        const res = yield* postChat(
          config,
          "generateText",
          yield* chatRequestBody(config, options, false),
          true,
          routingHeaders,
        )
        if (!res.ok) {
          return yield* failStatus(config, "generateText", res)
        }
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => aiUnknown(config.moduleName, "generateText", e, config.apiKey),
        })
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text) as ChatCompletion,
          catch: () =>
            invalidOutput(config.moduleName, "generateText", `the completion body was not JSON: ${text.slice(0, 200)}`),
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
            false,
            routingHeaders,
          )
          if (!res.ok) {
            return yield* failStatus(config, "streamText", res)
          }
          const body = res.body
          if (body === null) {
            return yield* Effect.fail(invalidOutput(config.moduleName, "streamText", "the streaming response carried no body"))
          }
          return sseStreamParts({ moduleName: config.moduleName, body })
        }),
      ) as never,
  }).pipe(Effect.map((model) => describeModel(model,
    Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }).pipe(
      Effect.map(({ cacheKey, policy }) => {
        const settings = requestSettings(config, cacheKey, policy)
        return { provider: config.moduleName, model: config.model, settings: { ...settings.sampling, ...settings.extensions } }
      }),
    ),
  )))
  })
