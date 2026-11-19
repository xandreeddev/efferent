import { Match, Option, Predicate, Result, Schema } from "effect"
import { AiError, Tool } from "effect/ai"
import type { LanguageModel, Prompt, Response } from "effect/ai"
import { ErrorChunk, WireChunk } from "./chat-wire.entity.js"
import type { Reading, WireCall, WireMessage, WireTool, WireUsage } from "./chat-wire.entity.js"

/** The parts of a message that are text, joined. */
const textOf = (parts: ReadonlyArray<{ readonly type: string }>): string =>
  parts.flatMap((part) => (part.type === "text" && Predicate.hasProperty(part, "text") && Predicate.isString(part.text) ? [part.text] : [])).join("")

/** A value as the text the wire sends: a string as it is, anything else as JSON. */
const asText = (value: unknown): string => (Predicate.isString(value) ? value : JSON.stringify(value) ?? "null")

/** Why a prompt cannot be sent on this wire: it holds a part the wire carries no text for. */
export type Unsendable = { readonly part: string }

const userMessage = (message: Prompt.UserMessage): Result.Result<ReadonlyArray<WireMessage>, Unsendable> => {
  const other = message.content.find((part) => part.type !== "text")
  if (other !== undefined) return Result.fail({ part: other.type })
  const content = textOf(message.content)
  return Result.succeed(content.length > 0 ? [{ role: "user", content }] : [])
}

const assistantMessage = (message: Prompt.AssistantMessage): ReadonlyArray<WireMessage> => {
  const content = textOf(message.content)
  const calls = message.content.flatMap((part): ReadonlyArray<WireCall> =>
    part.type === "tool-call" ? [{ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.params) ?? "{}" } }] : [])
  if (content.length === 0 && calls.length === 0) return []
  return [{ role: "assistant", content: content.length > 0 ? content : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }]
}

/**
 * A prompt as the wire's messages: system and user text, each call the assistant made with its id, each result
 * answering its call's id, a result that is no text as its JSON. Reasoning the model gave is not sent back. A user's
 * file is refused: the wire sends text, and nothing is sent in its place.
 */
export const wireMessages = (prompt: Prompt.Prompt): Result.Result<ReadonlyArray<WireMessage>, Unsendable> =>
  Result.map(
    Result.all(prompt.content.map((message): Result.Result<ReadonlyArray<WireMessage>, Unsendable> => Match.value(message).pipe(
      Match.discriminatorsExhaustive("role")({
        system: (system) => Result.succeed<ReadonlyArray<WireMessage>>(system.content.length > 0 ? [{ role: "system", content: system.content }] : []),
        user: userMessage,
        assistant: (assistant) => Result.succeed(assistantMessage(assistant)),
        tool: (tool) => Result.succeed(tool.content.flatMap((part): ReadonlyArray<WireMessage> =>
          part.type === "tool-result" ? [{ role: "tool", tool_call_id: part.id, content: asText(part.result) }] : [])),
      }),
    ))),
    (groups) => groups.flat(),
  )

/** The tools offered, as the wire declares them: name, description and the JSON schema of their parameters. */
export const wireTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<WireTool> =>
  tools.map((tool) => ({ type: "function", function: { name: tool.name, description: Tool.getDescription(tool) ?? "", parameters: Tool.getJsonSchema(tool) } }))

/**
 * The tools a call offers and how the model may use them, as the wire says it: every tool, or those a `oneOf` names;
 * `auto`, `none`, `required`, or one tool by name.
 */
export const toolFieldsOf = (tools: ReadonlyArray<Tool.Any>, choice: LanguageModel.ProviderOptions["toolChoice"]): Schema.JsonObject => {
  const named = (names: ReadonlyArray<string>) => tools.filter((tool) => names.includes(tool.name))
  const [offered, wireChoice]: readonly [ReadonlyArray<Tool.Any>, Schema.Json] = Predicate.isString(choice)
    ? [tools, choice]
    : "tool" in choice
      ? [named([String(choice.tool)]), { type: "function", function: { name: String(choice.tool) } }]
      : [named(choice.oneOf.map(String)), choice.mode === "required" ? "required" : "auto"]
  if (offered.length === 0) return {}
  return { tools: wireTools(offered).map((tool) => ({ type: tool.type, function: { name: tool.function.name, description: tool.function.description, parameters: toJson(tool.function.parameters) } })), tool_choice: wireChoice }
}

/** A JSON schema as the JSON value it is: decoded, so a body holds JSON alone. */
const toJson = (value: unknown): Schema.Json => Option.getOrElse(Schema.decodeUnknownOption(Schema.Json)(value), () => ({}))

/** A `data:` line's chunk, decoded; none for a line that is no chunk. */
export const chunkOf = (data: string): Option.Option<WireChunk> => Schema.decodeUnknownOption(Schema.fromJsonString(WireChunk))(data)

/** The words of an error chunk, when the line is one: the provider failed part way through the answer. */
export const errorIn = (data: string): Option.Option<string> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(ErrorChunk))(data), (chunk) => chunk.error.message ?? "the provider failed part way")

/** What one answer's stream has read before its first chunk. */
export const startReading: Reading = { text: false, calls: new Map(), finish: undefined, usage: undefined }

/**
 * One chunk read: the parts it hands on now (text as it comes) and what is kept for the end (a call's pieces, the
 * finish, the usage). A call is handed on whole at the end: its arguments arrive in pieces.
 */
export const readChunk = (reading: Reading, chunk: WireChunk): { readonly reading: Reading; readonly parts: ReadonlyArray<Response.StreamPartEncoded> } => {
  const parts: Array<Response.StreamPartEncoded> = []
  let text = reading.text
  const calls = new Map(reading.calls)
  let finish = reading.finish
  for (const choice of chunk.choices ?? []) {
    const content = choice.delta?.content
    if (content !== undefined && content !== null && content.length > 0) {
      if (!text) parts.push({ type: "text-start", id: "text" })
      text = true
      parts.push({ type: "text-delta", id: "text", delta: content })
    }
    for (const call of choice.delta?.tool_calls ?? []) {
      const known = calls.get(call.index) ?? { id: "", name: "", args: "" }
      calls.set(call.index, {
        id: known.id.length > 0 ? known.id : call.id ?? "",
        name: known.name.length > 0 ? known.name : call.function?.name ?? "",
        args: known.args + (call.function?.arguments ?? ""),
      })
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason
  }
  const usage = chunk.usage !== undefined && chunk.usage !== null ? chunk.usage : reading.usage
  return { reading: { text, calls, finish, usage }, parts }
}

/** A call's arguments as the model wrote them: an object when they read as JSON, else the text as it came. */
const paramsOf = (args: string): Schema.Json =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(args.length > 0 ? args : "{}"), () => args)

/** The finish reasons the wire gives, in Effect AI's words. */
const FINISH: Readonly<Record<string, Response.FinishReason>> = { stop: "stop", length: "length", tool_calls: "tool-calls", content_filter: "content-filter" }
const finishReason = (reason: string | undefined): Response.FinishReason =>
  reason === undefined ? "unknown" : Object.hasOwn(FINISH, reason) ? FINISH[reason] ?? "other" : "other"

/** What the provider counted, in Effect AI's usage: none of a count it did not give. */
export const usageOf = (usage: WireUsage | undefined): typeof Response.Usage.Encoded => {
  if (usage === undefined) return { inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? undefined
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? undefined
  const total = usage.prompt_tokens ?? undefined
  return {
    inputTokens: { total, cacheRead, cacheWrite, uncached: total === undefined ? undefined : total - (cacheRead ?? 0) - (cacheWrite ?? 0) },
    outputTokens: { total: usage.completion_tokens ?? undefined, text: undefined, reasoning: usage.completion_tokens_details?.reasoning_tokens ?? undefined },
  }
}

/** The stream's end: the text closed, each call whole in the order the model asked (a call with no id named by its place), then the finish with the usage. */
export const endReading = (reading: Reading): ReadonlyArray<Response.StreamPartEncoded> => [
  ...(reading.text ? [{ type: "text-end", id: "text" } as const] : []),
  ...[...reading.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]): Response.StreamPartEncoded => ({ type: "tool-call", id: call.id.length > 0 ? call.id : `call_${index}`, name: call.name, params: paramsOf(call.args), providerExecuted: false })),
  { type: "finish", reason: finishReason(reading.finish), usage: usageOf(reading.usage) },
]

/** A streamed answer's parts as one answer's: the text joined into one part, every other part as it came. */
export const settled = (parts: ReadonlyArray<Response.StreamPartEncoded>): Array<Response.PartEncoded> => {
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
  const rest = parts.flatMap((part): Array<Response.PartEncoded> => (part.type === "tool-call" || part.type === "finish" || part.type === "response-metadata" ? [part] : []))
  return [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...rest]
}

/** The words of a failed response's body: its error's message when it is the wire's error, else its start. */
const saidIn = (body: string): string => Option.getOrElse(
  Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(ErrorChunk))(body), (chunk) => Option.fromNullishOr(chunk.error.message)),
  () => body.slice(0, 300),
)

/**
 * A refusal or failure the provider answered with, as an `AiError` whose reason says whether another try is worth it:
 * a key refused (401) or not allowed the model (403) and no credit (402) are not; a rate limit (429), a request that
 * outlived its wait (408) and the provider's own failure (5xx) are; anything else is a request it will not take.
 */
export const failureOf = (module: string, method: string, status: number, body: string): AiError.AiError => {
  const said = saidIn(body)
  const description = said.length > 0 ? said : `the provider answered ${status}`
  const reason = status === 401 ? new AiError.AuthenticationError({ kind: "InvalidKey", description })
    : status === 403 ? new AiError.AuthenticationError({ kind: "InsufficientPermissions", description })
      : status === 402 ? new AiError.QuotaExhaustedError({})
        : status === 429 ? new AiError.RateLimitError({})
          : status === 408 || status >= 500 ? new AiError.InternalProviderError({ description })
            : new AiError.InvalidRequestError({ description })
  return AiError.make({ module, method, reason })
}

/**
 * What the provider reported one whole answer used, in the charge's counts, with what it billed when it says; none
 * when it said neither its counts nor its bill, which leaves the call's usage unknown, never zero.
 */
export const reportedOf = (usage: WireUsage | undefined): Option.Option<{ readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly billed: number | undefined }> => {
  if (usage === undefined) return Option.none()
  const billed = usage.cost ?? undefined
  const input = usage.prompt_tokens ?? undefined
  const output = usage.completion_tokens ?? undefined
  if (billed === undefined && (input === undefined || output === undefined)) return Option.none()
  return Option.some({ input: input ?? 0, output: output ?? 0, cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: usage.prompt_tokens_details?.cache_write_tokens ?? 0, billed })
}
