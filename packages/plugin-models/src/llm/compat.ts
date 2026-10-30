import { AiError, LanguageModel, Prompt, Tool, type Response as ResponseParts } from "effect/ai"
import { Cause, Effect, Match, Option, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, describeModel, ImageMediaType, mediaLabel, reasonOf } from "@xandreed/core"
import { strictJsonSchema, toolParametersSchema } from "@xandreed/core/internal"
import type { ModelCallPolicy } from "@xandreed/core"
import { finishReasonFromWire, sseStreamParts, usageFromCompletion } from "./sse.js"
import type { UsageReading } from "./sse.js"
import type { ChatCompletion } from "./chat-wire.entity.js"
import { decodeChatCompletion, decodeToolArguments, gatewayErrorOf, isModelRejection, isQuotaExhausted } from "./chat-wire.entity.functions.js"
import { publicReasoningEffort } from "./modelCatalog.js"
import type { ModelsFetch } from "../ports/models-transport.port.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"

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

/**
 * The reason a gateway's failed request fails with, from its status and the
 * structured error of its body. A rejected model is an invalid request
 * whatever the status (gateways answer it with one normally meaning a bad
 * key, so agents and evals do not diagnose "bad key" for an unsupported
 * model). An exhausted balance or quota (a 402, or an error type or code
 * naming one: `isQuotaExhausted`) is a `QuotaExhaustedError`, which is not
 * retried and does not fall back; a plain 429 stays a rate limit. Any other
 * status is mapped as effect/ai maps it.
 */
const gatewayFailure = (
  moduleName: string,
  status: number,
  body: string,
  http: typeof AiError.HttpContext.Type,
): AiError.AiErrorReason => {
  const error = gatewayErrorOf(body)
  const message = Option.getOrElse(Option.flatMap(error, (found) => Option.fromNullishOr(found.message)), () => "")
  if (Option.exists(error, isModelRejection)) {
    return new AiError.InvalidRequestError({ description: message.length > 0 ? message : "the selected model is not supported" })
  }
  if (isQuotaExhausted(Option.some(status), error)) {
    return new AiError.QuotaExhaustedError({ metadata: { [moduleName]: { ...Option.getOrElse(error, () => ({})) } }, http })
  }
  return AiError.reasonFromHttpStatus({ status, http, description: body.slice(0, 500) })
}

export interface CompatConfig {
  /** Module name for `AiError` provenance (e.g. "OpenCode"). */
  readonly moduleName: string
  /** Full chat-completions endpoint. */
  readonly chatUrl: string
  /** Bearer key (already resolved). Omit for keyless endpoints such as a local server. */
  readonly apiKey?: string
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
  /** How the endpoint's usage is read (default: every count, reasoning
   *  included; see `UsageReading`). */
  readonly usage?: UsageReading
  /** The model reads images: send them as `image_url` parts (default false: label lines; see `toChatMessages`). */
  readonly images?: boolean
  /** The fetch requests go through (the models plugin passes its `ModelsTransport`'s, which knows the proxy); defaults to the global fetch. */
  readonly fetchImpl?: ModelsFetch
  /** Host-owned admission (e.g. reserve a worst-case cost) before every call. */
  readonly beforeRequest?: (body: Readonly<Record<string, unknown>>) => Effect.Effect<void, AiError.AiError>
  /** Per-call accounting/resource boundary. Non-streaming responses are fully
   * buffered inside request so interruption also aborts body consumption. */
  readonly aroundRequest?: (body: Readonly<Record<string, unknown>>, request: Effect.Effect<Response, AiError.AiError>) => Effect.Effect<Response, AiError.AiError>
}

/** A request that failed before any response, described by the failure's text as `reasonOf` reads it (never a stack: an `AiError` reason has no slot for the failure itself), proxy credentials redacted (the description can reach a session log). */
const aiUnknown = (moduleName: string, method: string, e: unknown): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.UnknownError({ description: redactCredentials(reasonOf(Cause.die(e))) }) })

const invalidOutput = (moduleName: string, method: string, description: string): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.InvalidOutputError({ description }) })

/** A response the provider got wrong (not the model): a protocol failure, which the loop does not answer with a corrective turn. */
const invalidResponse = (moduleName: string, method: string, description: string): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.InvalidResponseError({ description }) })

const requestInfo = (chatUrl: string) => ({
  method: "POST" as const,
  url: chatUrl,
  urlParams: [] as Array<[string, string]>,
  headers: { "content-type": "application/json" },
})

const isImageType = Schema.is(ImageMediaType)

/** The bytes a file part's inline data decodes to: a byte array's length, or the size its base64 (a `data:` prefix allowed) stands for. */
const decodedBytes = (data: string | Uint8Array): number => {
  if (typeof data !== "string") return data.length
  const base64 = data.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "")
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * The line a request carries in place of a file part it does not send: an
 * inline image's `mediaLabel` (`[image omitted: image/png, 70 B, pixel.png]`,
 * as memory labels it), anything else `[file omitted: <type>, <name>]`.
 */
const filePartLabel = (part: Prompt.FilePart): string => {
  const data = part.data
  return isImageType(part.mediaType) && !(data instanceof URL)
    ? mediaLabel({ mediaType: part.mediaType, bytes: decodedBytes(data), ...(part.fileName === undefined ? {} : { name: part.fileName }) })
    : `[file omitted: ${[part.mediaType, ...(part.fileName === undefined ? [] : [part.fileName])].join(", ")}]`
}

/** An image a chat-completions request can carry: one of the image types, inline or by URL. */
const isSendableImage = (part: Prompt.FilePart): boolean => isImageType(part.mediaType)

/** An image file part → a chat-completions `image_url` part: its URL, or a `data:` URL of its base64. */
const imageUrlPart = (part: Prompt.FilePart): Json => {
  const data = part.data
  const url = data instanceof URL ? data.toString()
    : data instanceof Uint8Array ? `data:${part.mediaType};base64,${Base64.encode(data)}`
      : /^(data:|https?:\/\/)/i.test(data) ? data : `data:${part.mediaType};base64,${data}`
  return { type: "image_url", image_url: { url } }
}

const nonEmpty = (line: string): boolean => line.length > 0

/**
 * A tool result's text: its model output's text parts, each image not sent
 * as its label line (`images: false`); a result without model output is its
 * result, as before.
 */
const toolResultText = (part: Prompt.ToolResultPart, images: boolean): string =>
  part.modelOutput === undefined
    ? typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? null)
    : part.modelOutput.flatMap((output) => output.type === "text" ? [output.text]
      : images && isSendableImage(output) ? [] : [filePartLabel(output)]).filter(nonEmpty).join("\n")

/** A user message's text when its images are not sent: its text, then a label line per file part, so a message of images alone is never empty. */
const userText = (message: Prompt.UserMessage): string => {
  const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
  const labels = message.content.flatMap((p) => (p.type === "file" ? [filePartLabel(p)] : []))
  return [text, ...labels].filter(nonEmpty).join("\n")
}

/** How `toChatMessages` writes a request. */
export interface ChatMessageOptions {
  /** Send images as `image_url` parts (default false: label lines). */
  readonly images?: boolean
}

/** What the conversion holds between messages: the messages so far, and the tool images waiting for a user message. */
interface ChatFold {
  readonly out: ReadonlyArray<Json>
  readonly pending: ReadonlyArray<Json>
}

/** A user message's content as parts (a string is one text part; an empty one, none). */
const contentParts = (content: unknown): ReadonlyArray<unknown> =>
  typeof content === "string" ? content.length === 0 ? [] : [{ type: "text", text: content }]
    : Array.isArray(content) ? content : []

/** What precedes a user message's parts merged after tool images, when it has images of its own. */
const USER_CAPTION = "The user's message:"

/** The waiting tool images as one user message, after the tool results. */
const flush = (fold: ChatFold): ReadonlyArray<Json> =>
  fold.pending.length === 0 ? fold.out : [...fold.out, { role: "user", content: fold.pending }]

/**
 * Decoded `Prompt` messages → chat-completions message objects. A
 * text-only user message is its text, as before. Without `images`, a user
 * message is one string: its text, then a label line per file part, and a
 * tool result is its text with a label line per image. With `images`, a
 * user message with images is a content array of its parts in order (an
 * image as an `image_url` part with a `data:` URL), and a tool result is its
 * text in the tool message, while its images, which a tool message cannot
 * carry, follow all the batch's tool messages in one user message, each
 * result's captioned `Images returned by <tool> (call <id>):`; a user
 * message right after the batch is merged into it, so no two user messages
 * follow each other, captioned `The user's message:` when it has images of
 * its own.
 */
export const toChatMessages = (prompt: Prompt.Prompt, options: ChatMessageOptions = {}): ReadonlyArray<Json> => {
  const images = options.images ?? false
  const userMessage = (message: Prompt.UserMessage): Json => {
    const sendsImages = images && message.content.some((p) => p.type === "file" && isSendableImage(p))
    if (!sendsImages) return { role: "user", content: userText(message) }
    return {
      role: "user",
      content: message.content.flatMap((p): ReadonlyArray<Json> => p.type === "text"
        ? p.text.length === 0 ? [] : [{ type: "text", text: p.text }]
        : isSendableImage(p) ? [imageUrlPart(p)] : [{ type: "text", text: filePartLabel(p) }]),
    }
  }
  const folded = prompt.content.reduce((fold: ChatFold, message): ChatFold => Match.value(message).pipe(Match.discriminatorsExhaustive("role")({
    user: (asked): ChatFold => {
      const user = userMessage(asked)
      if (fold.pending.length === 0) return { out: [...fold.out, user], pending: [] }
      // The user's own images, after the tool's: a caption tells them apart.
      const parts = contentParts(user["content"])
      const own = parts.some((part) => typeof part === "object" && part !== null && "type" in part && part.type === "image_url")
      return { out: [...fold.out, { role: "user", content: [...fold.pending, ...(own ? [{ type: "text", text: USER_CAPTION }] : []), ...parts] }], pending: [] }
    },
    tool: (tool): ChatFold => {
      // One chat message per result part, keyed by the originating call id (a provider-run tool's is left out, as its call is).
      const results = tool.content.flatMap((p) => p.type === "tool-result" && !p.providerExecuted ? [p] : [])
      const sent = results.flatMap((p) => {
        const parts = images ? (p.modelOutput ?? []).flatMap((output) => output.type === "file" && isSendableImage(output) ? [output] : []) : []
        return parts.length === 0 ? [] : [{ type: "text", text: `Images returned by ${p.name} (call ${p.id}):` }, ...parts.map(imageUrlPart)]
      })
      const toolMessages = results.map((p): Json => {
        const text = toolResultText(p, images)
        const hasImages = images && (p.modelOutput ?? []).some((output) => output.type === "file" && isSendableImage(output))
        return { role: "tool", tool_call_id: p.id, content: text.length === 0 && hasImages ? "[the images this call returned follow]" : text }
      })
      return { out: [...fold.out, ...toolMessages], pending: [...fold.pending, ...sent] }
    },
    system: (system): ChatFold => ({ out: [...flush(fold), { role: "system", content: system.content }], pending: [] }),
    assistant: (assistant): ChatFold => {
      const text = assistant.content
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("")
      const toolCalls = assistant.content.flatMap((p) =>
        p.type === "tool-call" && !p.providerExecuted // a provider-run tool (call and result) is the provider's own: neither is sent
          ? [
              {
                id: p.id,
                type: "function" as const,
                function: { name: p.name, arguments: JSON.stringify(p.params ?? {}) },
              },
            ]
          : [],
      )
      return {
        out: [...flush(fold), {
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        }],
        pending: [],
      }
    },
  })), { out: [], pending: [] })
  return flush(folded)
}

/**
 * A prompt with every file part a label line: what a route that reads no
 * images is sent (the models plugin rewrites a request so on such routes).
 * A user message with file parts becomes one text part (its text, then a
 * label line each); a tool result with model output becomes its text with a
 * label line per file part, as its result. Messages without files are kept.
 */
export const promptWithImageLabels = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(prompt.content.map((message): Prompt.Message => Match.value(message).pipe(Match.discriminatorsExhaustive("role")({
    user: (user): Prompt.Message => user.content.some((p) => p.type === "file")
      ? Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: userText(user) })], options: user.options })
      : user,
    tool: (tool): Prompt.Message => tool.content.some((p) => p.type === "tool-result" && p.modelOutput !== undefined)
      ? Prompt.makeMessage("tool", {
        content: tool.content.map((p) => p.type !== "tool-result" || p.modelOutput === undefined ? p : Prompt.makePart("tool-result", {
          id: p.id, name: p.name, isFailure: p.isFailure, result: toolResultText(p, false), providerExecuted: p.providerExecuted, options: p.options,
        })),
        options: tool.options,
      })
      : tool,
    // Neither carries files.
    system: (system): Prompt.Message => system,
    assistant: (assistant): Prompt.Message => assistant,
  }))))

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

const toToolChoice = (choice: LanguageModel.ProviderOptions["toolChoice"]): Schema.Json => {
  if (choice === "none" || choice === "required") return choice
  if (typeof choice === "object" && "tool" in choice) {
    return {
      type: "function" as const,
      function: { name: String(choice.tool) },
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
export const thinkingParams = (model: string): Schema.JsonObject => {
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

/** Parse one non-streaming completion into `@effect/ai` encoded parts. */
export const fromChatCompletion = Effect.fnUntraced(function* (
  moduleName: string,
  body: ChatCompletion,
  reading: UsageReading = {},
): Effect.fn.Return<ReadonlyArray<ResponseParts.PartEncoded>, AiError.AiError> {
  const choice = body.choices?.[0]
  if (choice === undefined) {
    return yield* Effect.fail(invalidResponse(moduleName, "generateText", "the completion carried no choices"))
  }
  const message = choice.message ?? {}
  // The gateway fronts multiple upstreams with two reasoning vocabularies —
  // models think by DEFAULT (no request param), so missing either field
  // silently drops the thinking (live-caught on kimi-k2.6).
  const reasoning = message.reasoning_content ?? message.reasoning
  const text = message.content
  const toolCalls = yield* Effect.forEach(message.tool_calls ?? [], (tc) =>
    decodeToolArguments(tc.function?.arguments ?? "{}").pipe(
      Effect.map((params): ResponseParts.ToolCallPartEncoded => ({
        type: "tool-call",
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        params,
      })),
      Effect.mapError(() =>
        invalidOutput(moduleName, "generateText", `tool call ${tc.function?.name ?? "?"} carried unparseable JSON arguments`),
      ),
    ),
    { concurrency: 1 },
  )
  return [
    ...(reasoning !== null && reasoning !== undefined && reasoning.length > 0
      ? [{ type: "reasoning" as const, text: reasoning }]
      : []),
    ...(text !== null && text !== undefined && text.length > 0
      ? [{ type: "text" as const, text }]
      : []),
    ...toolCalls,
    {
      type: "finish" as const,
      reason:
        toolCalls.length > 0 ? "tool-calls" : finishReasonFromWire(choice.finish_reason),
      usage: usageFromCompletion(body.usage, reading),
    },
  ]
})

/** A request's public options, shared by the body and the model's descriptor:
 *  the sampling temperature (sent before the messages) and the gateway
 *  extensions (sent after them), as the wire has always ordered them; JSON, as the descriptor records them. */
const requestSettings = (config: CompatConfig, cacheKey: Option.Option<string>, policy: Option.Option<ModelCallPolicy>): { readonly sampling: Schema.JsonObject; readonly extensions: Schema.JsonObject } => ({
  sampling: config.temperature === undefined ? {} : { temperature: config.temperature },
  extensions: config.standardOnly === true ? {} : {
    ...Option.match(cacheKey, { onNone: () => ({}), onSome: (key) => ({ prompt_cache_key: key }) }),
    ...(config.thinking === undefined ? thinkingParams(config.model) : { thinking: { type: config.thinking } }),
    ...(config.reasoningEffort === undefined ? {} : { reasoning: { effort: config.reasoningEffort } }),
    ...Option.match(policy, {
      onNone: () => ({}),
      onSome: (value) => ({
        ...(value.maxOutputTokens === undefined ? {} : { max_tokens: value.maxOutputTokens }),
        // The call policy's effort in the chat-completions vocabulary (`max`, `xhigh` and `none` are no gateway's).
        ...(config.thinking === "disabled" || config.reasoningEffort !== undefined ? {} : { reasoning_effort: publicReasoningEffort(value.effort) }),
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
  Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }, { concurrency: 1 }).pipe(
    Effect.map(({ cacheKey, policy }) => {
      const tools = toChatTools(options.tools)
      const settings = requestSettings(config, cacheKey, policy)
      return {
        model: config.model,
        ...settings.sampling,
        messages: toChatMessages(options.prompt, { images: config.images ?? false }),
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
): Effect.Effect<Response, AiError.AiError> => {
  const request = (config.beforeRequest?.(body) ?? Effect.void).pipe(Effect.andThen(Effect.tryPromise({
    try: async (signal) => {
      const response = await (config.fetchImpl ?? fetch)(config.chatUrl, {
        signal,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey === undefined || config.apiKey.length === 0 ? {} : { authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify(body),
      })
      // Keep cancellation attached through non-streaming body consumption.
      return buffered ? new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers }) : response
    },
    catch: (e) => aiUnknown(config.moduleName, method, e),
  })))
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
      catch: (e) => aiUnknown(config.moduleName, method, e),
    })
    // (forEach, not Object.fromEntries — this lib config's Headers type has
    // no entries(); the mutation is contained to this literal.)
    const headers: Record<string, string> = {}
    res.headers.forEach((value, headerName) => {
      headers[headerName] = value
    })
    return yield* Effect.fail(
      AiError.make({
        module: config.moduleName,
        method,
        reason: gatewayFailure(config.moduleName, res.status, text, {
          request: requestInfo(config.chatUrl), response: { status: res.status, headers }, body: text.slice(0, 500),
        }),
      }),
    )
  })

export const makeCompatLanguageModel = (
  config: CompatConfig,
): Effect.Effect<LanguageModel.LanguageModel> =>
  LanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        const res = yield* postChat(
          config,
          "generateText",
          yield* chatRequestBody(config, options, false),
          true,
        )
        if (!res.ok) {
          return yield* failStatus(config, "generateText", res)
        }
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => aiUnknown(config.moduleName, "generateText", e),
        })
        const parsed = yield* decodeChatCompletion(config.moduleName, text)
        return (yield* fromChatCompletion(config.moduleName, parsed, config.usage)) as never
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
            return yield* Effect.fail(invalidResponse(config.moduleName, "streamText", "the streaming response carried no body"))
          }
          return sseStreamParts({ moduleName: config.moduleName, body, ...(config.usage === undefined ? {} : { usage: config.usage }) })
        }),
      ) as never,
  }).pipe(Effect.map((model) => describeModel(model,
    Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }, { concurrency: 1 }).pipe(
      Effect.map(({ cacheKey, policy }) => {
        const settings = requestSettings(config, cacheKey, policy)
        return { provider: config.moduleName, model: config.model, settings: { ...settings.sampling, ...settings.extensions } }
      }),
    ),
  )))
