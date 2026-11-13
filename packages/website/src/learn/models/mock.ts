// "Echo": a model that needs no download, so every part of the lesson (chat,
// streaming, events, the context inspector) works on any device. It is a
// scripted stand-in, and says so: it answers only from the messages it was
// sent, which is what makes it useful for seeing what an agent's memory holds.
import { Effect, Stream } from "effect"
import type { Prompt } from "effect/ai"
import type { ChatMessage } from "../prompt-map.ts"
import { settledParts, streamDelta, streamEnd, streamFinish, streamStart, toChatMessages, usageOf } from "../prompt-map.ts"
import { makeBrowserModel } from "./make.ts"
import type { LoadedModel, ModelChoice } from "./types.ts"

export const echoChoice: ModelChoice = {
  id: "echo",
  kind: "echo",
  label: "Echo (instant)",
  blurb: "No download. A scripted stand-in: it answers only from the messages it was sent, so it shows exactly what your agent's memory holds.",
  memoryMB: 0,
}

const clip = (text: string, max = 60): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A note a memory wrapper added for this request (lesson 3's clock): code's, not something the user said. */
const CLOCK = /^\[Host note: it is ([^\]]+?)\.?\]$/
const isClock = (message: ChatMessage): boolean => message.role === "user" && CLOCK.test(message.content)
const isLedger = (message: ChatMessage): boolean => message.role === "user" && message.content.startsWith("[Host note:") && !isClock(message)
const isNote = (message: ChatMessage): boolean => isLedger(message) || isClock(message)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/** What Echo says, from the messages the agent sent it. */
export const echoReply = (messages: ReadonlyArray<ChatMessage>): string => {
  const system = messages.find((message) => message.role === "system")
  const clock = messages.findLast(isClock)
  const turns = messages.filter((message) => message.role !== "system" && !isClock(message))
  const users = turns.filter((message) => message.role === "user" && !isNote(message))
  const last = users[users.length - 1]?.content ?? ""
  const earlierUsers = users.slice(0, -1)
  const ledger = turns.some(isLedger)
  const earlier = turns.length - 1

  // Several messages since its last answer: a turn that took every message waiting. It answers them together.
  const lastAnswer = turns.map((message) => message.role).lastIndexOf("assistant")
  const together = turns.slice(lastAnswer + 1).filter((message) => message.role === "user" && !isLedger(message))
  if (together.length > 1) {
    const before = turns.length - together.length
    return `You sent ${together.length} messages: ${together.map((message) => `"${clip(message.content, 40)}"`).join(", ")}. ${before > 0 ? `I can also see ${plural(before, "earlier message")}.` : "They start the conversation."}`
  }
  if (/\b(what time|the time|time is it|clock)\b/i.test(last)) {
    const now = clock === undefined ? undefined : CLOCK.exec(clock.content)?.[1]
    return now === undefined ? "Nothing I was sent says the time: I only know what is in the messages." : `A note your code added to this request says it is ${now}. It was not stored: the next request gets its own.`
  }
  if (/^\s*(hi|hello|hey|hola|howdy)\b/i.test(last)) {
    return "Hello! I'm Echo, a scripted stand-in model. Ask me what you said earlier and I'll answer from the messages I was sent."
  }
  if (/\b(remember|recap|earlier|so far|summari[sz]e)\b|what (did|have) (i|we)\b/i.test(last)) {
    if (earlierUsers.length === 0 && !ledger) return "This is the first message, so I have nothing earlier to recall."
    const said = earlierUsers.slice(-5).map((message) => `"${clip(message.content)}"`).join(", ")
    const note = ledger ? " Older turns were condensed into a short note, so I only see a summary of those." : ""
    return `${earlierUsers.length > 0 ? `Earlier you said: ${said}.` : "I only have a condensed note about earlier turns."}${note}`
  }
  if (/\b(context|journal|window|system prompt|what can you see)\b/i.test(last)) {
    return `I was sent a system prompt of ${system?.content.length ?? 0} characters, ${plural(earlier, "earlier message")}${ledger ? " (one is a note condensing older turns)" : ""}, and your message.`
  }
  return `You said: "${clip(last)}". ${earlier > 0 ? `I can also see ${plural(earlier, "earlier message")}.` : "This is the start of the conversation."}`
}

const words = (text: string): ReadonlyArray<string> => text.match(/\S+\s*/g) ?? []

/** A call Echo makes: the tool and its parameters. */
interface EchoCall {
  readonly name: string
  readonly params: Record<string, unknown>
}

const OPS: Record<string, string> = { "+": "+", "-": "-", "*": "*", x: "*", "×": "*", "/": "/", "÷": "/" }

/**
 * What Echo does with tools offered: by rule, so a lesson can rely on it. Sums go to the calculator, "remember …" to
 * remember, a question about notes to recall; a message that just got tool results is answered from them.
 */
export const echoStep = (sent: Prompt.Prompt, offered: ReadonlyArray<string>): { readonly text: string; readonly calls: ReadonlyArray<EchoCall> } => {
  // A note code added for this request is not a message to answer or a sum to work out.
  const prompt = { ...sent, content: sent.content.filter((message) => !(message.role === "user" && message.content.every((part) => part.type === "text" && CLOCK.test(part.text)))) }
  const last = prompt.content.at(-1)
  if (last?.role === "tool") {
    const said = last.content.flatMap((part) => (part.type === "tool-result" ? [`${part.name} ${part.isFailure ? "failed: " : "says "}${JSON.stringify(part.result)}`] : []))
    // Every result since the last call, in order.
    const results = prompt.content.slice().reverse()
    const since = results.findIndex((message) => message.role !== "tool")
    const all = results.slice(0, since < 0 ? results.length : since).reverse().flatMap((message) =>
      message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [`${part.name} ${part.isFailure ? "failed: " : "says "}${JSON.stringify(part.result)}`] : [])) : [])
    // A helper's answer (lesson 4's delegate) is passed on as the helper's, not as a tool's JSON.
    const helped = last.content.flatMap((part) => (part.type === "tool-result" && part.name === "delegate" && !part.isFailure && typeof part.result === "object" && part.result !== null && "answer" in part.result ? [String(part.result.answer)] : []))
    if (helped.length > 0) return { text: `The helper answered: ${helped.join(" ")}`, calls: [] }
    return { text: `The ${all.length > 1 ? "tools" : "tool"} answered: ${(all.length > 0 ? all : said).join("; ")}.`, calls: [] }
  }
  // Every message sent since its last answer: the turn's own, and any that steered it.
  const since = prompt.content.length - 1 - prompt.content.slice().reverse().findIndex((message) => message.role === "assistant" || message.role === "tool")
  const pending = prompt.content.slice(since > prompt.content.length - 1 ? 0 : since + 1).flatMap((message) =>
    message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : [])
  const callFor = (asked: string): ReadonlyArray<EchoCall> => {
    // "Ask a helper: …", "have a helper work out …": the rest is the helper's task.
    const handed = /\b(?:ask|have|get) a helper\b[\s:,-]*(?:to\s+)?(.+)/i.exec(asked)
    if (handed !== null && offered.includes("delegate")) return [{ name: "delegate", params: { task: handed[1]?.trim() ?? "" } }]
    if (/\b(notes?|what did i ask you to remember)\b/i.test(asked) && offered.includes("recall")) return [{ name: "recall", params: {} }]
    const sum = /(-?\d+(?:\.\d+)?)\s*([-+*x×/÷])\s*(-?\d+(?:\.\d+)?)/.exec(asked)
    if (sum !== null && offered.includes("calculator")) return [{ name: "calculator", params: { a: Number(sum[1]), op: OPS[sum[2] ?? "+"] ?? "+", b: Number(sum[3]) } }]
    const note = /\bremember (?:that )?(.+)/i.exec(asked)
    if (note !== null && offered.includes("remember")) return [{ name: "remember", params: { note: note[1]?.trim() ?? "" } }]
    return []
  }
  const calls = pending.flatMap(callFor)
  if (calls.length > 0) return { text: calls.length > 1 ? `Let me use ${calls.length} tools.` : "Let me work that out.", calls }
  return { text: echoReply(toChatMessages(sent)), calls: [] }
}

let echoCalls = 0

export const loadEcho = (): LoadedModel => {
  let interrupted = false
  const model = makeBrowserModel({
    generateText: (options) => Effect.sync(() => {
      const messages = toChatMessages(options.prompt)
      const reply = echoReply(messages)
      return settledParts(reply, usageOf(messages, reply)) as never
    }),
    streamText: (options) => {
      const messages = toChatMessages(options.prompt)
      const { text: reply, calls } = options.tools.length > 0 ? echoStep(options.prompt, options.tools.map((tool) => tool.name)) : { text: echoReply(messages), calls: [] }
      interrupted = false
      const asked = calls.map((call) => ({ type: "tool-call" as const, id: `echo-call-${++echoCalls}`, name: call.name, params: call.params }))
      return Stream.fromIterable(words(reply)).pipe(
        Stream.mapEffect((word) => Effect.sleep("35 millis").pipe(Effect.as(word))),
        Stream.takeWhile(() => !interrupted),
        Stream.map(streamDelta),
        (deltas) => Stream.concat(Stream.concat(Stream.make(streamStart), deltas), Stream.suspend(() => Stream.fromIterable([streamEnd, ...(interrupted ? [] : asked), streamFinish(usageOf(messages, reply))]))),
      ) as never
    },
  }, "native")
  return { choice: echoChoice, model, interrupt: () => { interrupted = true }, dispose: () => {} }
}
