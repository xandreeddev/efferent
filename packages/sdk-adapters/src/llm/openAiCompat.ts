import { AiError, LanguageModel, Prompt, Response, Tool } from "@effect/ai"
import { Chunk, Effect, Option, Stream } from "effect"
import { LLM_REQUEST_TIMEOUT_MS } from "./retry.js"

/**
 * A generic OpenAI-compatible chat-completions `LanguageModel` over raw
 * `fetch` + SSE. The `@effect/ai-openai` client targets api.openai.com; many
 * providers (OpenCode's gateway, z.ai's `…/paas/v4`, others) speak the same
 * `/chat/completions` protocol at a different base URL with a Bearer key, so
 * this client is parameterized by `chatUrl` + `apiKey` rather than hardcoding
 * either. Provider-specific thinking knobs are keyed off the **model id**
 * (`thinkingParams`), so the same client serves GLM / DeepSeek / Kimi / Qwen.
 *
 * Thin wrappers in `openCode.ts` / `zai.ts` bind the base URL; nothing else
 * differs between those providers.
 */

type Json = Record<string, unknown>

/** Per-provider config for one `LanguageModel.Service`. */
export interface OpenAiCompatConfig {
  /** Module name for `AiError` provenance (e.g. "OpenCode", "Zai"). */
  readonly moduleName: string
  /** Full chat-completions endpoint, e.g. `https://api.z.ai/api/paas/v4/chat/completions`. */
  readonly chatUrl: string
  /** Bearer key (already resolved from the AuthStore). */
  readonly apiKey: string
  /** Provider-native model id. */
  readonly model: string
  /** Extended-thinking toggle; `undefined` leaves it to the provider default. */
  readonly thinkingMode?: "off" | "high" | undefined
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
  headers: {
    "content-type": "application/json",
    accept: "text/event-stream",
  },
})

const responseError = (
  moduleName: string,
  chatUrl: string,
  status: number,
  headers: Headers,
  body: string,
): AiError.HttpResponseError => {
  const responseHeaders: Record<string, string> = {}
  headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  return new AiError.HttpResponseError({
    module: moduleName,
    method: "chatCompletion",
    reason: "StatusCode",
    request: requestInfo(chatUrl),
    response: {
      status,
      headers: responseHeaders,
    },
    body,
    description: body.slice(0, 500),
  })
}

const malformed = (
  moduleName: string,
  description: string,
  cause?: unknown,
): AiError.MalformedOutput =>
  new AiError.MalformedOutput({
    module: moduleName,
    method: "decodeStream",
    description,
    ...(cause !== undefined ? { cause } : {}),
  })

/** Map a Prompt to standard OpenAI chat-completions messages. */
const toMessages = (prompt: Prompt.Prompt): ReadonlyArray<Json> => {
  const out: Json[] = []
  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content })
        break
      case "user": {
        const text = message.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("")
        out.push({ role: "user", content: text })
        break
      }
      case "assistant": {
        const textParts: string[] = []
        const toolCalls: Json[] = []
        for (const part of message.content) {
          if (part.type === "text") {
            textParts.push(part.text)
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.params ?? {}),
              },
            })
          }
        }
        const msg: Json = { role: "assistant" }
        if (textParts.length > 0) {
          msg.content = textParts.join("")
        } else if (toolCalls.length > 0) {
          msg.content = null
        }
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls
        }
        out.push(msg)
        break
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            out.push({
              role: "tool",
              tool_call_id: part.id,
              content: JSON.stringify(part.result),
            })
          }
        }
        break
      }
    }
  }
  return out
}

/** OpenAI chat-completions tool schema. */
const toTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<Json> | undefined =>
  tools.length === 0
    ? undefined
    : tools.flatMap((tool) => {
        if (!Tool.isUserDefined(tool)) return []
        return [
          {
            type: "function" as const,
            function: {
              name: tool.name,
              description: Tool.getDescription(tool as never),
              parameters: Tool.getJsonSchema(tool as never),
            },
          },
        ]
      })

const toToolChoice = (toolChoice: LanguageModel.ToolChoice<string>): unknown => {
  if (toolChoice === "none" || toolChoice === "required") return toolChoice
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return { type: "function" as const, function: { name: toolChoice.tool } }
  }
  return "auto"
}

const responseTextFormat = (format: LanguageModel.ProviderOptions["responseFormat"]): Json => {
  if (format.type === "text") return { type: "text" }
  return {
    type: "json_schema" as const,
    json_schema: {
      name: format.objectName,
      schema: Tool.getJsonSchemaFromSchemaAst(format.schema.ast) as unknown,
      strict: false,
    },
  }
}

// Deepseek-style: thinking: { type: "enabled" | "disabled" } — used by Kimi K2.6 and DeepSeek V4.
// supportsReasoningEffort is false for Kimi; DeepSeek accepts it too but we skip it (binary on/off is enough).
const isDeepseekThinking = (model: string): boolean =>
  /kimi-k2\.[1-9]/i.test(model) || /deepseek/i.test(model)

// Qwen-style: enable_thinking: boolean
const isQwenThinking = (model: string): boolean => /qwen/i.test(model)

const thinkingParams = (model: string, mode: "off" | "high"): Json => {
  if (isDeepseekThinking(model)) {
    return { thinking: { type: mode === "off" ? "disabled" : "enabled" } }
  }
  if (isQwenThinking(model)) {
    return { enable_thinking: mode !== "off" }
  }
  // Standard OpenAI reasoning_effort (e.g. MiMo, GLM, MiniMax, Kimi K2.5)
  return mode === "off" ? {} : { reasoning_effort: mode }
}

const requestBody = (
  model: string,
  options: LanguageModel.ProviderOptions,
  thinkingMode?: "off" | "high",
): Json => {
  const messages = toMessages(options.prompt)
  const tools = toTools(options.tools)
  return {
    model,
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(tools !== undefined ? { tool_choice: toToolChoice(options.toolChoice) } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.responseFormat.type !== "text"
      ? { response_format: responseTextFormat(options.responseFormat) }
      : {}),
    ...(thinkingMode !== undefined ? thinkingParams(model, thinkingMode) : {}),
  }
}

const headers = (apiKey: string): HeadersInit => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "text/event-stream",
})

const postChat = (
  moduleName: string,
  chatUrl: string,
  apiKey: string,
  body: Json,
): Effect.Effect<Response, AiError.AiError> =>
  Effect.tryPromise({
    try: () =>
      fetch(chatUrl, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      }),
    catch: (e) => aiUnknown(moduleName, "chatCompletion", e),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.succeed(res)
        : Effect.promise(() => res.text()).pipe(
            Effect.flatMap((b) =>
              Effect.fail(responseError(moduleName, chatUrl, res.status, res.headers, b)),
            ),
          ),
    ),
  )

const parseSse = (
  moduleName: string,
  stream: ReadableStream<Uint8Array>,
): Stream.Stream<Json, AiError.AiError> =>
  Stream.fromReadableStream(() => stream, (e) => aiUnknown(moduleName, "readStream", e)).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum([] as string[], (lines, line) => {
      if (line.length === 0) {
        const payload = lines.join("\n")
        return [[], payload.length > 0 ? [payload] : []]
      }
      if (line.startsWith("data:")) return [[...lines, line.slice(5).trimStart()], []]
      return [lines, []]
    }),
    Stream.mapConcat((payloads) => payloads),
    Stream.filter((payload) => payload !== "[DONE]"),
    Stream.mapEffect((payload) =>
      Effect.try({
        try: () => JSON.parse(payload) as Json,
        catch: (e) => malformed(moduleName, `failed to parse SSE event: ${payload.slice(0, 200)}`, e),
      }),
    ),
  )

const finishReason = (reason: unknown): Response.FinishReason => {
  if (reason === "max_tokens" || reason === "length") return "length"
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls"
  if (typeof reason === "string" && reason.length > 0) return "stop"
  return "stop"
}

const usageFromChunk = (chunk: Json): Response.FinishPartEncoded["usage"] => {
  const usage = chunk.usage as Json | undefined
  const input = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
  const output = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined
  const total = typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined

  const cached =
    typeof (usage?.prompt_tokens_details as Json)?.cached_tokens === "number"
      ? ((usage?.prompt_tokens_details as Json)?.cached_tokens as number)
      : typeof usage?.prompt_cache_hit_tokens === "number"
        ? usage.prompt_cache_hit_tokens
        : typeof usage?.cached_tokens === "number"
          ? usage.cached_tokens
          : typeof usage?.cached_prompt_tokens === "number"
            ? usage.cached_prompt_tokens
            : undefined

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      total !== undefined
        ? total
        : input !== undefined && output !== undefined
          ? input + output
          : undefined,
    cachedInputTokens: cached,
  }
}

/** Collect SSE deltas into Response stream parts. */
const eventParts = () => {
  const activeToolCalls = new Map<number, { id: string; name: string; args: string }>()

  return (event: Json): ReadonlyArray<Response.StreamPartEncoded> => {
    const choices = event.choices as ReadonlyArray<Json> | undefined
    if (choices === undefined || choices.length === 0) {
      // Could be a final usage-only chunk
      const usage = usageFromChunk(event)
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        return [{ type: "finish", reason: "stop", usage, metadata: {} }]
      }
      return []
    }

    const choice = choices[0]!
    const delta = choice.delta as Json | undefined
    if (delta === undefined) return []

    const out: Response.StreamPartEncoded[] = []

    // Text content
    const content = typeof delta.content === "string" ? delta.content : undefined
    if (content !== undefined && content.length > 0) {
      out.push({
        type: "text-delta",
        id: "0",
        delta: content,
      })
    }

    // Tool calls
    const toolCalls = delta.tool_calls as ReadonlyArray<Json> | undefined
    if (toolCalls !== undefined) {
      for (const tc of toolCalls) {
        const index = typeof tc.index === "number" ? tc.index : 0
        const id = typeof tc.id === "string" ? tc.id : undefined
        const fn = tc.function as Json | undefined
        const name = typeof fn?.name === "string" ? fn.name : undefined
        const args = typeof fn?.arguments === "string" ? fn.arguments : undefined

        if (id !== undefined && name !== undefined) {
          activeToolCalls.set(index, { id, name, args: "" })
          out.push({ type: "tool-params-start", id, name })
        }

        const existing = activeToolCalls.get(index)
        if (existing !== undefined && args !== undefined && args.length > 0) {
          existing.args += args
          out.push({ type: "tool-params-delta", id: existing.id, delta: args })
        }
      }
    }

    // Finish reason
    const finish = choice.finish_reason
    if (finish !== undefined && finish !== null) {
      // Flush any completed tool calls before finish
      for (const [index, tool] of activeToolCalls) {
        let params: unknown
        try {
          params = Tool.unsafeSecureJsonParse(tool.args.length > 0 ? tool.args : "{}")
        } catch {
          params = {}
        }
        out.push({ type: "tool-params-end", id: tool.id })
        out.push({
          type: "tool-call",
          id: tool.id,
          name: tool.name,
          params,
          providerExecuted: false,
          metadata: {},
        })
        activeToolCalls.delete(index)
      }

      out.push({
        type: "finish",
        reason: finishReason(finish),
        usage: usageFromChunk(event),
        metadata: {},
      })
    }

    return out
  }
}

const responseStream = (
  moduleName: string,
  chatUrl: string,
  apiKey: string,
  body: Json,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    postChat(moduleName, chatUrl, apiKey, body).pipe(
      Effect.flatMap((res) =>
        res.body === null
          ? Effect.fail(responseError(moduleName, chatUrl, res.status, res.headers, "empty response body"))
          : Effect.succeed(parseSse(moduleName, res.body).pipe(Stream.mapConcat(eventParts()))),
      ),
    ),
  )

export const collectStreamParts = (
  parts: ReadonlyArray<Response.StreamPartEncoded>,
): Response.PartEncoded[] => {
  const out: Response.PartEncoded[] = []
  const text = new Map<string, { value: string }>()

  const flushText = (id: string) => {
    const value = text.get(id)
    if (value !== undefined) out.push({ type: "text", text: value.value })
    text.delete(id)
  }

  for (const part of parts) {
    switch (part.type) {
      case "text-delta": {
        const current = text.get(part.id) ?? { value: "" }
        text.set(part.id, { value: `${current.value}${part.delta}` })
        break
      }
      case "tool-call":
      case "tool-result":
      case "response-metadata":
      case "finish":
        out.push(part)
        break
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
      case "error":
        break
    }
  }
  for (const id of text.keys()) flushText(id)
  return out
}

/**
 * Build a `LanguageModel.Service` for one OpenAI-compatible provider endpoint.
 * `generateText` collects the SSE stream; `streamText` returns it raw.
 */
export const makeOpenAiCompatLanguageModel = (
  config: OpenAiCompatConfig,
): Effect.Effect<LanguageModel.Service> => {
  const { moduleName, chatUrl, apiKey, model, thinkingMode } = config
  return LanguageModel.make({
    generateText: (options) =>
      responseStream(moduleName, chatUrl, apiKey, requestBody(model, options, thinkingMode)).pipe(
        Stream.runCollect,
        Effect.map((chunk) => collectStreamParts(Chunk.toArray(chunk))),
      ),
    streamText: (options) =>
      responseStream(moduleName, chatUrl, apiKey, requestBody(model, options, thinkingMode)),
  })
}
