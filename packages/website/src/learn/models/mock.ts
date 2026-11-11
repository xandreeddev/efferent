// "Echo": a model that needs no download, so every part of the lesson (chat,
// streaming, events, the context inspector) works on any device. It is a
// scripted stand-in, and says so: it answers only from the messages it was
// sent, which is what makes it useful for seeing what an agent's memory holds.
import { Effect, Stream } from "effect"
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

const isLedger = (message: ChatMessage): boolean => message.role === "user" && message.content.startsWith("[Host note:")
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/** What Echo says, from the messages the agent sent it. */
export const echoReply = (messages: ReadonlyArray<ChatMessage>): string => {
  const system = messages.find((message) => message.role === "system")
  const turns = messages.filter((message) => message.role !== "system")
  const users = turns.filter((message) => message.role === "user" && !isLedger(message))
  const last = users[users.length - 1]?.content ?? ""
  const earlierUsers = users.slice(0, -1)
  const ledger = turns.some(isLedger)
  const earlier = turns.length - 1

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
      const reply = echoReply(messages)
      interrupted = false
      return Stream.fromIterable(words(reply)).pipe(
        Stream.mapEffect((word) => Effect.sleep("35 millis").pipe(Effect.as(word))),
        Stream.takeWhile(() => !interrupted),
        Stream.map(streamDelta),
        (deltas) => Stream.concat(Stream.concat(Stream.make(streamStart), deltas), Stream.make(streamEnd, streamFinish(usageOf(messages, reply)))),
      ) as never
    },
  })
  return { choice: echoChoice, model, interrupt: () => { interrupted = true }, dispose: () => {} }
}
