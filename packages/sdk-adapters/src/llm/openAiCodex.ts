import { AiError, LanguageModel, Prompt, Response, Tool, type Toolkit } from "@effect/ai"
import { Chunk, Effect, Option, Stream } from "effect"
import { LLM_REQUEST_TIMEOUT_MS } from "./retry.js"

export const OPENAI_CODEX_API_URL = "https://chatgpt.com/backend-api/codex"
export const OPENAI_CODEX_RESPONSES_URL = `${OPENAI_CODEX_API_URL}/responses`
export const OPENAI_CODEX_INSTRUCTIONS =
  "You are Efferent, an interactive coding agent running inside a terminal. Follow the developer/system instructions in the conversation, use tools when needed, and keep responses concise."

type Json = Record<string, unknown>

type OpenAiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high"

interface CodexAuth {
  readonly access: string
  readonly accountId?: string
  readonly installationId: string
  readonly reasoningEffort?: OpenAiReasoningEffort
}

const requestInfo = {
  method: "POST" as const,
  url: OPENAI_CODEX_RESPONSES_URL,
  urlParams: [] as Array<[string, string]>,
  hash: Option.none<string>(),
  headers: {
    "content-type": "application/json",
    accept: "text/event-stream",
  },
}

const aiUnknown = (method: string, e: unknown): AiError.UnknownError =>
  new AiError.UnknownError({
    module: "OpenAiCodex",
    method,
    description: String(e),
    cause: e,
  })

const responseError = (
  status: number,
  headers: Headers,
  body: string,
): AiError.HttpResponseError => {
  const responseHeaders: Record<string, string> = {}
  headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  return new AiError.HttpResponseError({
    module: "OpenAiCodex",
    method: "createResponseStream",
    reason: "StatusCode",
    request: requestInfo,
    response: {
      status,
      headers: responseHeaders,
    },
    body,
    description: body.slice(0, 500),
  })
}

const malformed = (description: string, cause?: unknown): AiError.MalformedOutput =>
  new AiError.MalformedOutput({
    module: "OpenAiCodex",
    method: "decodeStream",
    description,
    ...(cause !== undefined ? { cause } : {}),
  })

const openaiOptions = (options: unknown): Json | undefined => {
  if (typeof options !== "object" || options === null) return undefined
  const openai = (options as { readonly openai?: unknown }).openai
  return typeof openai === "object" && openai !== null ? (openai as Json) : undefined
}

const itemId = (part: { readonly options?: unknown }): string | undefined => {
  const value = openaiOptions(part.options)?.itemId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const encryptedContent = (part: { readonly options?: unknown }): string | undefined => {
  const value = openaiOptions(part.options)?.encryptedContent
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const outputTextItem = (text: string, id?: string): Json => ({
  ...(id !== undefined ? { id } : {}),
  role: "assistant",
  content: [{ type: "output_text", text }],
})

const toInputItems = (
  prompt: Prompt.Prompt,
): { readonly instructions: string; readonly input: ReadonlyArray<Json> } => {
  const instructions: string[] = [OPENAI_CODEX_INSTRUCTIONS]
  const input: Json[] = []

  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        if (message.content.trim().length > 0) instructions.push(message.content)
        break
      case "user":
        input.push({
          role: "user",
          content: message.content
            .filter((part) => part.type === "text")
            .map((part) => ({ type: "input_text", text: part.text })),
        })
        break
      case "assistant":
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              input.push(outputTextItem(part.text, itemId(part)))
              break
            case "reasoning": {
              const id = itemId(part)
              if (id !== undefined) {
                input.push({
                  id,
                  type: "reasoning",
                  summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
                  ...(encryptedContent(part) !== undefined
                    ? { encrypted_content: encryptedContent(part) }
                    : {}),
                })
              }
              break
            }
            case "tool-call":
              if (!part.providerExecuted) {
                input.push({
                  ...(itemId(part) !== undefined ? { id: itemId(part) } : {}),
                  type: "function_call",
                  call_id: part.id,
                  name: part.name,
                  arguments: JSON.stringify(part.params ?? {}),
                })
              }
              break
            case "tool-result":
              input.push({
                type: "function_call_output",
                call_id: part.id,
                output: JSON.stringify(part.result),
              })
              break
            default:
              break
          }
        }
        break
      case "tool":
        for (const part of message.content) {
          input.push({
            type: "function_call_output",
            call_id: part.id,
            output: JSON.stringify(part.result),
          })
        }
        break
    }
  }

  return { instructions: instructions.join("\n\n"), input }
}

const toTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<Json> =>
  tools.flatMap((tool) => {
    if (!Tool.isUserDefined(tool)) return []
    return [{
      type: "function",
      name: tool.name,
      description: Tool.getDescription(tool as never),
      parameters: Tool.getJsonSchema(tool as never),
      strict: false,
    }]
  })

const toToolChoice = (toolChoice: LanguageModel.ToolChoice<string>): unknown => {
  if (toolChoice === "none" || toolChoice === "required") return toolChoice
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return { type: "function", name: toolChoice.tool }
  }
  return "auto"
}

const responseTextFormat = (format: LanguageModel.ProviderOptions["responseFormat"]): Json => {
  if (format.type === "text") return { format: { type: "text" } }
  return {
    format: {
      type: "json_schema",
      name: format.objectName,
      schema: Tool.getJsonSchemaFromSchemaAst(format.schema.ast) as unknown,
      strict: false,
    },
  }
}

const supportsReasoning = (model: string): boolean =>
  /^gpt-5/i.test(model) || /^o\d/i.test(model)

export const codexRequestBody = (
  model: string,
  options: LanguageModel.ProviderOptions,
  reasoningEffort?: OpenAiReasoningEffort,
): Json => {
  const { instructions, input } = toInputItems(options.prompt)
  const reasoning = supportsReasoning(model)
    ? { summary: "auto", ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}) }
    : undefined
  return {
    model,
    instructions,
    input,
    tools: toTools(options.tools),
    tool_choice: toToolChoice(options.toolChoice),
    parallel_tool_calls: true,
    store: false,
    stream: true,
    ...(reasoning !== undefined
      ? { reasoning, include: ["reasoning.encrypted_content"] }
      : { include: [] }),
    prompt_cache_key: "efferent",
    text: responseTextFormat(options.responseFormat),
    client_metadata: {
      "x-codex-installation-id": "efferent",
    },
  }
}

const headers = (auth: CodexAuth): HeadersInit => ({
  Authorization: `Bearer ${auth.access}`,
  ...(auth.accountId !== undefined ? { "ChatGPT-Account-ID": auth.accountId } : {}),
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  originator: "efferent",
  "User-Agent": "efferent",
  "x-codex-installation-id": auth.installationId,
})

const postResponse = (
  auth: CodexAuth,
  body: Json,
): Effect.Effect<Response, AiError.AiError> =>
  Effect.tryPromise({
    try: () =>
      fetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({
          ...body,
          client_metadata: {
            ...((body.client_metadata as Json | undefined) ?? {}),
            "x-codex-installation-id": auth.installationId,
          },
        }),
        signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      }),
    catch: (e) => aiUnknown("createResponseStream", e),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.succeed(res)
        : Effect.promise(() => res.text()).pipe(
            Effect.flatMap((body) => Effect.fail(responseError(res.status, res.headers, body))),
          ),
    ),
  )

const parseSse = (
  stream: ReadableStream<Uint8Array>,
): Stream.Stream<Json, AiError.AiError> =>
  Stream.fromReadableStream(() => stream, (e) => aiUnknown("readStream", e)).pipe(
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
        catch: (e) => malformed(`failed to parse SSE event: ${payload.slice(0, 200)}`, e),
      }),
    ),
  )

const finishReason = (reason: unknown, hasToolCalls: boolean): Response.FinishReason => {
  if (hasToolCalls) return "tool-calls"
  if (reason === "max_output_tokens" || reason === "max_tokens") return "length"
  if (typeof reason === "string" && reason.length > 0) return "stop"
  return "stop"
}

const usageFromResponse = (response: Json | undefined): Response.FinishPartEncoded["usage"] => {
  const usage = (response?.usage ?? {}) as Json
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined
  const outputDetails = (usage.output_tokens_details ?? {}) as Json
  const inputDetails = (usage.input_tokens_details ?? {}) as Json
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : input !== undefined && output !== undefined
          ? input + output
          : undefined,
    reasoningTokens:
      typeof outputDetails.reasoning_tokens === "number"
        ? outputDetails.reasoning_tokens
        : undefined,
    cachedInputTokens:
      typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : undefined,
  }
}

const metadata = (itemId: string | undefined, extra?: Json): Response.ProviderMetadata =>
  itemId !== undefined || extra !== undefined
    ? { openai: { ...(itemId !== undefined ? { itemId } : {}), ...(extra ?? {}) } }
    : {}

const eventParts = () => {
  let hasToolCalls = false
  const activeToolCalls = new Map<number, { id: string; name: string }>()
  const activeReasoning = new Map<string, { encryptedContent?: string; summaries: Set<number> }>()

  return (event: Json): ReadonlyArray<Response.StreamPartEncoded> => {
    const type = event.type
    switch (type) {
      case "response.created": {
        const response = (event.response ?? {}) as Json
        return [{
          type: "response-metadata",
          id: String(response.id ?? ""),
          modelId: String(response.model ?? ""),
          timestamp: new Date(
            (typeof response.created_at === "number" ? response.created_at : Date.now() / 1000) *
              1000,
          ).toISOString(),
        }]
      }
      case "error":
        return [{ type: "error", error: event }]
      case "response.output_item.added": {
        const item = (event.item ?? {}) as Json
        const outputIndex = typeof event.output_index === "number" ? event.output_index : 0
        if (item.type === "message") {
          const id = String(item.id ?? event.item_id ?? outputIndex)
          return [{ type: "text-start", id, metadata: metadata(id) }]
        }
        if (item.type === "function_call") {
          const id = String(item.call_id ?? item.id ?? outputIndex)
          const name = String(item.name ?? "")
          activeToolCalls.set(outputIndex, { id, name })
          return [{ type: "tool-params-start", id, name }]
        }
        if (item.type === "reasoning") {
          const id = String(item.id ?? event.item_id ?? outputIndex)
          const encrypted =
            typeof item.encrypted_content === "string" ? item.encrypted_content : undefined
          activeReasoning.set(id, {
            summaries: new Set([0]),
            ...(encrypted !== undefined ? { encryptedContent: encrypted } : {}),
          })
          return [{
            type: "reasoning-start",
            id: `${id}:0`,
            metadata: metadata(id, encrypted !== undefined ? { encryptedContent: encrypted } : {}),
          }]
        }
        return []
      }
      case "response.output_text.delta":
        return [{
          type: "text-delta",
          id: String(event.item_id ?? event.output_index ?? "text"),
          delta: String(event.delta ?? ""),
        }]
      case "response.function_call_arguments.delta": {
        const outputIndex = typeof event.output_index === "number" ? event.output_index : 0
        const tool = activeToolCalls.get(outputIndex)
        return tool === undefined
          ? []
          : [{ type: "tool-params-delta", id: tool.id, delta: String(event.delta ?? "") }]
      }
      case "response.reasoning_summary_part.added": {
        const id = String(event.item_id ?? "")
        const summaryIndex = typeof event.summary_index === "number" ? event.summary_index : 0
        const active = activeReasoning.get(id)
        if (active !== undefined) active.summaries.add(summaryIndex)
        if (summaryIndex === 0) return []
        return [{
          type: "reasoning-start",
          id: `${id}:${summaryIndex}`,
          metadata: metadata(id, active?.encryptedContent !== undefined
            ? { encryptedContent: active.encryptedContent }
            : {}),
        }]
      }
      case "response.reasoning_summary_text.delta": {
        const id = String(event.item_id ?? "")
        const summaryIndex = typeof event.summary_index === "number" ? event.summary_index : 0
        return [{
          type: "reasoning-delta",
          id: `${id}:${summaryIndex}`,
          delta: String(event.delta ?? ""),
          metadata: metadata(id),
        }]
      }
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json
        const outputIndex = typeof event.output_index === "number" ? event.output_index : 0
        if (item.type === "message") {
          const id = String(item.id ?? event.item_id ?? outputIndex)
          return [{ type: "text-end", id }]
        }
        if (item.type === "function_call") {
          hasToolCalls = true
          const id = String(item.call_id ?? item.id ?? outputIndex)
          const rawArgs = typeof item.arguments === "string" ? item.arguments : "{}"
          let params: unknown
          try {
            params = Tool.unsafeSecureJsonParse(rawArgs)
          } catch {
            params = {}
          }
          activeToolCalls.delete(outputIndex)
          return [
            { type: "tool-params-end", id },
            {
              type: "tool-call",
              id,
              name: String(item.name ?? ""),
              params,
              providerExecuted: false,
              metadata: metadata(typeof item.id === "string" ? item.id : undefined),
            },
          ]
        }
        if (item.type === "reasoning") {
          const id = String(item.id ?? event.item_id ?? outputIndex)
          const active = activeReasoning.get(id)
          activeReasoning.delete(id)
          return Array.from(active?.summaries ?? [0]).map((summaryIndex) => ({
            type: "reasoning-end" as const,
            id: `${id}:${summaryIndex}`,
            metadata: metadata(id, active?.encryptedContent !== undefined
              ? { encryptedContent: active.encryptedContent }
              : {}),
          }))
        }
        return []
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = (event.response ?? {}) as Json
        const incomplete = (response.incomplete_details ?? {}) as Json
        return [{
          type: "finish",
          reason: finishReason(incomplete.reason, hasToolCalls),
          usage: usageFromResponse(response),
          metadata: {},
        }]
      }
      default:
        return []
    }
  }
}

const responseStream = (
  auth: CodexAuth,
  body: Json,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    postResponse(auth, body).pipe(
      Effect.flatMap((res) =>
        res.body === null
          ? Effect.fail(responseError(res.status, res.headers, "empty response body"))
          : Effect.succeed(parseSse(res.body).pipe(Stream.mapConcat(eventParts()))),
      ),
    ),
  )

export const collectStreamParts = (
  parts: ReadonlyArray<Response.StreamPartEncoded>,
): Response.PartEncoded[] => {
  const out: Response.PartEncoded[] = []
  const text = new Map<string, { value: string; metadata?: Response.ProviderMetadata }>()
  const reasoning = new Map<string, { value: string; metadata?: Response.ProviderMetadata }>()

  const flushText = (id: string) => {
    const value = text.get(id)
    if (value !== undefined) out.push({ type: "text", text: value.value, metadata: value.metadata })
    text.delete(id)
  }
  const flushReasoning = (id: string) => {
    const value = reasoning.get(id)
    if (value !== undefined) {
      out.push({ type: "reasoning", text: value.value, metadata: value.metadata })
    }
    reasoning.delete(id)
  }

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        text.set(part.id, {
          value: "",
          ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
        })
        break
      case "text-delta": {
        const current = text.get(part.id) ?? { value: "" }
        text.set(part.id, { ...current, value: `${current.value}${part.delta}` })
        break
      }
      case "text-end":
        flushText(part.id)
        break
      case "reasoning-start":
        reasoning.set(part.id, {
          value: "",
          ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
        })
        break
      case "reasoning-delta": {
        const current =
          reasoning.get(part.id) ?? {
            value: "",
            ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
          }
        reasoning.set(part.id, { ...current, value: `${current.value}${part.delta}` })
        break
      }
      case "reasoning-end":
        flushReasoning(part.id)
        break
      case "tool-call":
      case "tool-result":
      case "response-metadata":
      case "finish":
      case "file":
      case "source":
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
  for (const id of reasoning.keys()) flushReasoning(id)
  return out
}

export const makeOpenAiCodexLanguageModel = (
  model: string,
  auth: CodexAuth,
): Effect.Effect<LanguageModel.Service> =>
  LanguageModel.make({
    generateText: (options) =>
      responseStream(auth, codexRequestBody(model, options, auth.reasoningEffort)).pipe(
        Stream.runCollect,
        Effect.map((chunk) => collectStreamParts(Chunk.toArray(chunk))),
      ),
    streamText: (options) =>
      responseStream(auth, codexRequestBody(model, options, auth.reasoningEffort)),
  })

export type CodexToolkit = Toolkit.Any
