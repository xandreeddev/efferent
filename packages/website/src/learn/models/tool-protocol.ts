// Tools for the browser's small models, which have no tool calling of their
// own: the tools offered are described in the system text, in the format
// many small chat models were trained on (a JSON object inside
// <tool_call>…</tool_call>), calls and results already in the conversation
// are written the same way, and the model's answer is read back: the text
// before a call streams to the chat, and each block becomes a `tool-call`
// part. Small models get this wrong often; the lesson says so.
import { Stream } from "effect"
import { Prompt, Tool } from "effect/ai"
import type { LanguageModel, Response } from "effect/ai"

type Implementation = Parameters<typeof LanguageModel.make>[0]
type StreamOptions = Parameters<Implementation["streamText"]>[0]

const OPEN = "<tool_call>"
const CLOSE = "</tool_call>"

/** A JSON schema's type, as a signature reads it: `number`, `string`, or its enum's values. */
const typeOf = (schema: unknown): string => {
  if (typeof schema !== "object" || schema === null) return "value"
  if ("enum" in schema && Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if ("anyOf" in schema && Array.isArray(schema.anyOf)) return typeOf(schema.anyOf[0])
  return "type" in schema && typeof schema.type === "string" ? schema.type : "value"
}

/** An example value of a JSON schema's type, for the example call. */
const exampleOf = (schema: unknown): unknown => {
  if (typeof schema !== "object" || schema === null) return null
  if ("enum" in schema && Array.isArray(schema.enum)) return schema.enum[0]
  if ("anyOf" in schema && Array.isArray(schema.anyOf)) return exampleOf(schema.anyOf[0])
  const type = "type" in schema ? schema.type : undefined
  return type === "number" || type === "integer" ? 1 : type === "boolean" ? true : type === "array" ? [] : "text"
}

const propertiesOf = (tool: Tool.Any): ReadonlyArray<readonly [string, unknown]> => {
  const schema: unknown = Tool.getJsonSchema(tool)
  return typeof schema === "object" && schema !== null && "properties" in schema && typeof schema.properties === "object" && schema.properties !== null
    ? Object.entries(schema.properties)
    : []
}

/** A tool as one line a small model can read: `name(param: type, …): what it does`. */
const signatureOf = (tool: Tool.Any): string =>
  `- ${tool.name}(${propertiesOf(tool).map(([name, schema]) => `${name}: ${typeOf(schema)}`).join(", ")}): ${Tool.getDescription(tool) ?? ""}`

/** The system text's addition that offers the tools: one line each, and one example call. */
export const toolInstructions = (tools: ReadonlyArray<Tool.Any>): string => {
  const first = tools[0]
  const example = first === undefined ? "" : `${OPEN}${JSON.stringify({ name: first.name, arguments: Object.fromEntries(propertiesOf(first).map(([name, schema]) => [name, exampleOf(schema)])) })}${CLOSE}`
  return [
    "You have tools. To use one, reply with only a line like this, and nothing else:",
    example,
    "Its result comes back inside <tool_response></tool_response>. Then answer the user in words.",
    "",
    "Tools:",
    ...tools.map(signatureOf),
  ].join("\n")
}

const textOfParts = (parts: ReadonlyArray<Prompt.Part>): string =>
  parts.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "tool-call") return `${OPEN}${JSON.stringify({ name: part.name, arguments: part.params })}${CLOSE}`
    if (part.type === "tool-result") return `<tool_response>${JSON.stringify({ name: part.name, result: part.result, failed: part.isFailure })}</tool_response>`
    return ""
  }).join("")

/** The prompt as plain text messages: the tools offered in the system text, calls and results written as text. */
export const textPrompt = (prompt: Prompt.Prompt, tools: ReadonlyArray<Tool.Any>): Prompt.Prompt => {
  const offer = toolInstructions(tools)
  let offered = false
  const messages = prompt.content.map((message): Prompt.MessageEncoded => {
    if (message.role === "system") {
      offered = true
      return { role: "system", content: `${message.content}\n\n${offer}` }
    }
    if (message.role === "tool") return { role: "user", content: textOfParts(message.content) }
    if (message.role === "assistant") return { role: "assistant", content: textOfParts(message.content) }
    return { role: "user", content: textOfParts(message.content) }
  })
  return Prompt.make(offered ? messages : [{ role: "system", content: offer }, ...messages])
}

/** A call the model wrote, read back. */
export interface WrittenCall {
  readonly name: string
  readonly params: unknown
}

/** The calls written in `text`, and the text around them. A block that is no JSON call is left as text. */
export const readCalls = (text: string): { readonly text: string; readonly calls: ReadonlyArray<WrittenCall> } => {
  const calls: Array<WrittenCall> = []
  const rest = text.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (block, inner: string) => {
    try {
      const parsed: unknown = JSON.parse(inner.trim())
      if (typeof parsed === "object" && parsed !== null && "name" in parsed && typeof parsed.name === "string") {
        calls.push({ name: parsed.name, params: "arguments" in parsed ? parsed.arguments : {} })
        return ""
      }
    } catch { /* not a call: kept as text */ }
    return block
  })
  return { text: rest.trim().length === 0 ? "" : rest, calls }
}

/**
 * Passes the text a model streams on, but holds back from the first `<` that could open a call: once the stream
 * ends, what was held is read for calls. So a call never shows in the chat, and text that only looked like one is
 * let through at the end.
 */
export const callHolder = () => {
  let held = ""
  let holding = false
  const feedFrom = (delta: string): string => {
    const at = delta.indexOf("<")
    if (at < 0) return delta
    const rest = delta.slice(at)
    // Not the start of a call: pass it on and keep looking.
    if (!(rest.length < OPEN.length ? OPEN.startsWith(rest) : rest.startsWith(OPEN))) return delta.slice(0, at + 1) + feedFrom(rest.slice(1))
    holding = true
    held = rest
    return delta.slice(0, at)
  }
  return {
    feed: (delta: string): string => {
      if (holding) {
        held += delta
        // What is held can no longer open a call ("x < 3"): let it through, and look again from the next "<".
        if (held.length < OPEN.length ? OPEN.startsWith(held) : held.startsWith(OPEN)) return ""
        const out = held
        holding = false
        held = ""
        const again = out.indexOf("<", 1)
        return again < 0 ? out : out.slice(0, again) + feedFrom(out.slice(again))
      }
      return feedFrom(delta)
    },
    finish: () => readCalls(held),
  }
}

let next = 0

/** A browser model's implementation, given tools by the text protocol whenever a call offers them. */
export const withToolProtocol = (impl: Implementation): Implementation => ({
  ...impl,
  streamText: (options: StreamOptions) => {
    if (options.tools.length === 0) return impl.streamText(options)
    const holder = callHolder()
    const stream = impl.streamText({ ...options, prompt: textPrompt(options.prompt, options.tools) }) as Stream.Stream<Response.StreamPartEncoded, never>
    return stream.pipe(
      Stream.flatMap((part): Stream.Stream<Response.StreamPartEncoded> => {
        if (part.type === "text-delta") {
          const shown = holder.feed(part.delta)
          return shown.length > 0 ? Stream.make({ ...part, delta: shown }) : Stream.empty
        }
        if (part.type === "finish") {
          const { text, calls } = holder.finish()
          const leftover: ReadonlyArray<Response.StreamPartEncoded> = text.length > 0 ? [{ type: "text-delta", id: "text", delta: text }] : []
          const asked = calls.map((call): Response.StreamPartEncoded => ({ type: "tool-call", id: `browser-call-${++next}`, name: call.name, params: call.params }))
          return Stream.fromIterable([...leftover, ...asked, { ...part, reason: asked.length > 0 ? "tool-calls" : part.reason }])
        }
        return Stream.make(part)
      }),
    ) as ReturnType<Implementation["streamText"]>
  },
})
