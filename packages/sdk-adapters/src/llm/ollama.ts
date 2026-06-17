import { AiError, LanguageModel, Prompt, Response, Tool } from "@effect/ai"
import { Chunk, Effect, Option, Stream } from "effect"

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434"

type Json = Record<string, unknown>

const aiUnknown = (method: string, e: unknown): AiError.UnknownError =>
  new AiError.UnknownError({
    module: "Ollama",
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
    module: "Ollama",
    method: "chatCompletion",
    reason: "StatusCode",
    request: {
      method: "POST" as const,
      url: "",
      urlParams: [] as Array<[string, string]>,
      hash: Option.none<string>(),
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    },
    response: { status, headers: responseHeaders },
    body,
    description: body.slice(0, 500),
  })
}

const malformed = (description: string, cause?: unknown): AiError.MalformedOutput =>
  new AiError.MalformedOutput({
    module: "Ollama",
    method: "decodeStream",
    description,
    ...(cause !== undefined ? { cause } : {}),
  })

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

const requestBody = (model: string, options: LanguageModel.ProviderOptions): Json => {
  const messages = toMessages(options.prompt)
  const tools = toTools(options.tools)
  return {
    model,
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(tools !== undefined ? { tool_choice: toToolChoice(options.toolChoice) } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

const postChat = (
  chatUrl: string,
  body: Json,
): Effect.Effect<Response, AiError.AiError> =>
  Effect.tryPromise({
    try: () =>
      fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: "Bearer ollama",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      }),
    catch: (e) => aiUnknown("chatCompletion", e),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.succeed(res)
        : Effect.promise(() => res.text()).pipe(
            Effect.flatMap((b) => Effect.fail(responseError(res.status, res.headers, b))),
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

const finishReason = (reason: unknown): Response.FinishReason => {
  if (reason === "max_tokens" || reason === "length") return "length"
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls"
  if (typeof reason === "string" && reason.length > 0) return "stop"
  return "stop"
}

const usageFromChunk = (chunk: Json): Response.FinishPartEncoded["usage"] => {
  const usage = chunk.usage as Json | undefined
  const input = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
  const output =
    typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined
  const total = typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      total !== undefined
        ? total
        : input !== undefined && output !== undefined
          ? input + output
          : undefined,
    cachedInputTokens: undefined,
  }
}

const eventParts = () => {
  const activeToolCalls = new Map<number, { id: string; name: string; args: string }>()

  return (event: Json): ReadonlyArray<Response.StreamPartEncoded> => {
    const choices = event.choices as ReadonlyArray<Json> | undefined
    if (choices === undefined || choices.length === 0) {
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

    const content = typeof delta.content === "string" ? delta.content : undefined
    if (content !== undefined && content.length > 0) {
      out.push({ type: "text-delta", id: "0", delta: content })
    }

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

    const finish = choice.finish_reason
    if (finish !== undefined && finish !== null) {
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
  chatUrl: string,
  body: Json,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    postChat(chatUrl, body).pipe(
      Effect.flatMap((res) =>
        res.body === null
          ? Effect.fail(responseError(res.status, res.headers, "empty response body"))
          : Effect.succeed(parseSse(res.body).pipe(Stream.mapConcat(eventParts()))),
      ),
    ),
  )

export const makeOllamaLanguageModel = (
  baseUrl: string,
  model: string,
): Effect.Effect<LanguageModel.Service> => {
  const chatUrl = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`
  return LanguageModel.make({
    generateText: (options) =>
      responseStream(chatUrl, requestBody(model, options)).pipe(
        Stream.runCollect,
        Effect.map((chunk) => {
          const parts = Chunk.toArray(chunk)
          const out: Response.PartEncoded[] = []
          const text = new Map<string, { value: string }>()

          const flushText = (id: string) => {
            const entry = text.get(id)
            if (entry !== undefined) out.push({ type: "text", text: entry.value })
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
              default:
                break
            }
          }
          for (const id of text.keys()) flushText(id)
          return out
        }),
      ),
    streamText: (options) => responseStream(chatUrl, requestBody(model, options)),
  })
}
