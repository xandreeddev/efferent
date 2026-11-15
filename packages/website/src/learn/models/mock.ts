// "Echo": a model that needs no download, so every part of the lesson (chat,
// streaming, events, the context inspector) works on any device. It is a
// scripted stand-in, and says so: it answers only from the messages it was
// sent, which is what makes it useful for seeing what an agent's memory holds.
import { Effect, Stream } from "effect"
import type { Prompt } from "effect/ai"
import { APPROVAL_REFUSED, catalogue, LOAD_SKILL } from "@xandreed/sdk/kernel"
import type { ChatMessage } from "../prompt-map.ts"
import { settledParts, streamDelta, streamEnd, streamFinish, streamStart, toChatMessages, usageOf } from "../prompt-map.ts"
import { callIds } from "./call-ids.ts"
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
/** Any note the host added (a clock, a summary of older turns): never a message to answer or a sum to work out. */
const isHostNote = (text: string): boolean => text.startsWith("[Host note:")

/** The text inside `<tag>…</tag>`, when a message frames one. */
const framedIn = (tag: string, text: string): string | undefined => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1]

/**
 * What Echo answers a summarizer's request (lesson 5) with, by rule, so the lesson can rely on it: how many things the
 * user said before, the summary so far's count included, and the last of them. Short, whatever the conversation's length.
 */
export const echoSummary = (request: string): string => {
  const earlier = Number(/You said (\d+) things? earlier/.exec(framedIn("earlier-summary", request) ?? "")?.[1] ?? 0)
  const said = (framedIn("conversation-transcript", request) ?? "").split("\n")
    .flatMap((line) => (line.startsWith("user: ") && !isHostNote(line.slice(6)) ? [line.slice(6)] : []))
  const count = earlier + said.length
  const last = said.at(-1)
  return `You said ${plural(count, "thing")} earlier${last === undefined ? "" : `, the last: "${clip(last, 40)}"`}.`
}

/** What Echo says, from the messages the agent sent it. */
export const echoReply = (messages: ReadonlyArray<ChatMessage>): string => {
  const request = messages.findLast((message) => message.role === "user")?.content ?? ""
  if (request.includes("<conversation-transcript>")) return echoSummary(request)
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
    const summary = framedIn("conversation-summary", turns.findLast(isLedger)?.content ?? "")
    const note = summary !== undefined ? ` Older turns were replaced by a summary: "${clip(summary)}"` : ledger ? " Older turns were condensed into a short note, so I only see a summary of those." : ""
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

/** The table Echo asks `show` for, by rule: squares or cubes up to n (5 if none is named), or a times table. A few words: the tool makes the rows. */
const showTable = (match: RegExpExecArray): EchoCall => {
  const kind = match[1]!.toLowerCase()
  if (kind === "squares" || kind === "cubes") return { name: "show", params: { id: kind, table: kind, n: Number(match[2] ?? 5) } }
  return { name: "show", params: { id: `times-${kind}`, table: "times", n: Number(kind) } }
}

const OPS: Record<string, string> = { "+": "+", "-": "-", "*": "*", x: "*", "×": "*", "/": "/", "÷": "/" }

/** The first sentence of a text, on one line: up to its first full stop, question mark or exclamation mark; all of it when it has none. */
const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat
}

/**
 * The note under the start of a result that was cut short (lesson 8), by the exact words the kernel writes: how
 * long the result is, how much of it was sent, and the call that reads on.
 */
const POINTER = /\[Host note: the result above is cut short: it is (\d+) characters long and its first (\d+) are shown\. To read on, call readResult with result (\d+) and from (\d+)\.\]$/

/** A pointer Echo was sent in place of a long result: the start it frames, the result's length, and where to read on. */
interface Pointer {
  readonly preview: string
  readonly total: number
  readonly result: number
  readonly from: number
}

const pointerIn = (result: unknown): Pointer | undefined => {
  const note = typeof result === "string" ? POINTER.exec(result) : null
  if (note === null || typeof result !== "string") return undefined
  return { preview: framedIn("tool-result-preview", result) ?? "", total: Number(note[1]), result: Number(note[3]), from: Number(note[4]) }
}

/** A part of a result that `readResult` returned: its text, where it starts and ends, and the result's length. */
interface Page {
  readonly text: string
  readonly from: number
  readonly to: number
  readonly total: number
}

const pageIn = (result: unknown): Page | undefined =>
  typeof result === "object" && result !== null
    && "text" in result && typeof result.text === "string" && "from" in result && typeof result.from === "number"
    && "to" in result && typeof result.to === "number" && "total" in result && typeof result.total === "number"
    ? { text: result.text, from: result.from, to: result.to, total: result.total }
    : undefined

/**
 * The first whole sentence of a part: a part that starts inside a text opens with the end of a sentence, cut where
 * the characters fell, and that is passed over. A part that is nothing but such an end is quoted as it is.
 */
const firstWholeSentence = (page: Page): string => {
  const flat = page.text.replace(/\s+/g, " ").trim()
  const rest = page.from === 0 ? flat : flat.replace(/^.*?[.!?](?:\s+|$)/, "")
  return firstSentence(rest.length > 0 ? rest : flat)
}

/** A tool's result as a prompt carries it. */
interface ResultPart {
  readonly id: string
  readonly name: string
  readonly isFailure: boolean
  readonly result: unknown
}

/** What Echo says when `forget` was refused (lesson 9): the person did not approve it, so nothing was deleted. */
const NOT_APPROVED = "I did not delete anything: you did not approve it."

/** The first line of the kernel's catalogue of skills (lesson 10), word for word: a system text that holds it lists skills under it. */
const CATALOGUE_HEAD = catalogue([])

/** A skill as a catalogue lists it: its name, and its line. */
interface Listed {
  readonly id: string
  readonly summary: string
}

/** The skills a system text's catalogue lists: the lines under the kernel's first line, each `- name: summary`, up to the first line that is none. */
const listedIn = (system: string): ReadonlyArray<Listed> => {
  const lines = system.split("\n")
  const head = lines.indexOf(CATALOGUE_HEAD)
  if (head === -1) return []
  const listed: Array<Listed> = []
  for (const line of lines.slice(head + 1)) {
    const entry = /^- ([a-z][a-z0-9]*(?:-[a-z0-9]+)*): (.+)$/.exec(line)
    if (entry === null) break
    listed.push({ id: entry[1] ?? "", summary: entry[2] ?? "" })
  }
  return listed
}

/** The words of a text that are four letters or more, in lower case: what a message and a skill's line are matched by. */
const longWords = (text: string): ReadonlyArray<string> => text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []

/** Whether a skill's line in the catalogue covers a message: a word of the message, of four letters or more, is the skill's name or a word of its summary. */
const covers = (skill: Listed, asked: string): boolean => {
  const line = new Set([skill.id, ...longWords(skill.summary)])
  return longWords(asked).some((word) => line.has(word))
}

/** The skill a successful result of `loadSkill` names. */
const loadedBy = (part: ResultPart): string | undefined =>
  part.name === LOAD_SKILL && !part.isFailure && typeof part.result === "object" && part.result !== null && "skill" in part.result && typeof part.result.skill === "string"
    ? part.result.skill
    : undefined

/** The skill a message asks for by name: "load units", "load the units skill". The word after "load", in lower case. */
const namedToLoad = (asked: string): string | undefined => /\bload\s+(?:the\s+)?([a-z][a-z0-9-]*)\b/i.exec(asked)?.[1]?.toLowerCase()

/** A length and the unit to convert it to: "5 km in miles", "26.2 miles to km". */
const LENGTH = /(-?\d+(?:\.\d+)?)\s*(km|kilometres?|kilometers?|mi|miles?)\b.*?\b(?:in|to|into)\s+(km|kilometres?|kilometers?|mi|miles?)\b/i
const unitOf = (word: string): "km" | "mi" => (word.toLowerCase().startsWith("k") ? "km" : "mi")

/** The message that asks for the units skill's tool before the skill is loaded: the one place Echo calls a tool it was not offered. */
const UNLOADED_CALL = /\b(?:use|call)\s+(?:the\s+)?convert\s+without\s+loading\b/i

/** The skill whose loaded instructions Echo follows in its own answers (lesson 10): three lines, in fixed words. */
const HAIKU_SKILL = "haiku"
const HAIKU = "An echo answers\nin five, then seven, then five:\nthe skill told it to."

/**
 * What Echo says of one result in words of its own. Of `lookup` or `readResult` (lesson 8): the first sentence of
 * what it was sent (of a part read on, the first whole one), and how much of the whole that is. Of a `forget` that
 * failed with the kernel's refusal, word for word (lesson 9): that nothing was deleted. Of a `loadSkill` that
 * loaded a skill (lesson 10): that it is loaded, without its instructions. Of a `convert` that answered a number:
 * the length it was asked about and the number to one decimal, with its unit, read from the call's parameters
 * (`paramsOf`). Nothing for any other tool's result, or any other failure: those are answered as the tool's.
 */
const readingOf = (part: ResultPart, paramsOf: (id: string) => unknown): string | undefined => {
  if (part.name === "forget" && part.isFailure && part.result === APPROVAL_REFUSED) return NOT_APPROVED
  if (part.isFailure) return undefined
  const loaded = loadedBy(part)
  if (loaded !== undefined) return `Loaded ${loaded}.`
  if (part.name === "convert" && typeof part.result === "number") {
    const params = paramsOf(part.id)
    return typeof params === "object" && params !== null && "value" in params && typeof params.value === "number"
      && "from" in params && typeof params.from === "string" && "to" in params && typeof params.to === "string"
      ? `${params.value} ${params.from} is ${part.result.toFixed(1)} ${params.to}.`
      : undefined
  }
  if (part.name === "readResult") {
    const page = pageIn(part.result)
    return page === undefined ? undefined
      : `Characters ${page.from} to ${page.to} of ${page.total}: "${firstWholeSentence(page)}" ${page.to < page.total ? 'Say "read more" for the next part.' : "That is the end."}`
  }
  if (part.name !== "lookup" || typeof part.result !== "string") return undefined
  const pointer = pointerIn(part.result)
  return pointer === undefined
    ? `The article is ${part.result.length} characters long. It starts: "${firstSentence(part.result)}"`
    : `The article starts: "${firstSentence(pointer.preview)}" I was sent the first ${pointer.from} of ${pointer.total} characters. Say "read more" for the next part.`
}

/** The parameters of the call a prompt holds under an id: the last one, since an id can repeat. */
const paramsOfCall = (messages: Prompt.Prompt["content"]) => (id: string): unknown =>
  messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).flatMap((part) => (part.type === "tool-call" && part.id === id ? [part.params] : [])).at(-1)

/** Where "read more" reads on from: a result and a character, or the end of a result that was read through. */
type ReadOn = { readonly _tag: "At"; readonly result: number; readonly from: number } | { readonly _tag: "End" }

/**
 * The latest place to read on from in a prompt, looking back from its end: the last part `readResult` returned
 * (on from where it stopped, in the result its call named; nowhere when it reached the end), or the last pointer.
 * Whichever of the two comes later in the prompt wins, so a new lookup is what "read more" reads next.
 */
const readOnFrom = (messages: Prompt.Prompt["content"]): ReadOn | undefined => {
  /** The result a `readResult` call asked for: the call's own parameter, found by the call's id. */
  const askedFor = (id: string): number | undefined => {
    const params = paramsOfCall(messages)(id)
    return typeof params === "object" && params !== null && "result" in params && typeof params.result === "number" ? params.result : undefined
  }
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]!
    if (message.role !== "tool") continue
    for (let index = message.content.length - 1; index >= 0; index--) {
      const part = message.content[index]!
      if (part.type !== "tool-result") continue
      const page = part.name === "readResult" && !part.isFailure ? pageIn(part.result) : undefined
      if (page !== undefined) {
        if (page.to >= page.total) return { _tag: "End" }
        const result = askedFor(part.id)
        if (result !== undefined) return { _tag: "At", result, from: page.to }
      }
      const pointer = pointerIn(part.result)
      if (pointer !== undefined) return { _tag: "At", result: pointer.result, from: pointer.from }
    }
  }
  return undefined
}

/** How many characters Echo asks `readResult` for: short, so reading on takes a few steps a learner can watch. */
const READ_LENGTH = 400

/**
 * What Echo does with tools offered: by rule, so a lesson can rely on it. Sums go to the calculator, "remember …" to
 * remember, a question about notes to recall, "ask a helper" to delegate, "a table of" to show; a prompt that ends
 * with tool results is answered from them. Lesson 8's rules: "look up" or "tell me about" tides, volcanoes or
 * honeybees goes to lookup, and its result is answered with the first sentence Echo was sent and how much of the
 * whole that is (a pointer, or the whole article); "read more", "read on" or "go on" calls readResult from the
 * latest place a prompt gives (the last part read, else the last pointer), 400 characters at a time, and says so
 * when the tool is not offered, when nothing was cut short, or when the last part reached the end. Lesson 9's
 * rules: "forget", "delete" or "clear" my notes, the notes or all notes goes to forget, ahead of the rule that
 * sends any message about notes to recall; a forget that failed with the kernel's refusal (`APPROVAL_REFUSED`,
 * word for word) is answered "I did not delete anything: you did not approve it.", and any other result of it
 * as the tool's.
 *
 * Lesson 10's rules, for skills, each asleep where `loadSkill` (or `convert`) is not offered, and each ahead of
 * every rule above, in this order. "Use convert without loading" calls convert with 5 km to mi whether or not it
 * is offered: the one call Echo makes of a tool it was not sent. "Load units", "load the units skill" calls
 * loadSkill with the word after "load". A length with a unit to convert it to ("5 km in miles") goes to convert,
 * where it is offered. A message a skill's line in the catalogue covers (the kernel's catalogue in the system
 * text; a word of the message, of four letters or more, is the skill's name or a word of its summary) calls
 * loadSkill for the first such skill no result in the prompt has loaded. After a result that loaded a skill,
 * Echo goes on in the same turn: the turn's messages are read again, and any call they ask for that the turn has
 * not made is made (convert, now that it is offered). With no call left, a load is answered "Loaded units.",
 * and a convert's number as "5 km is 3.1 mi.". While a result in the prompt loaded the haiku skill, Echo writes
 * its own answers in three fixed lines: where it would answer a message with no tool, and after a load the
 * message did not ask for by name; a tool's answer is passed on as before.
 */
export const echoStep = (sent: Prompt.Prompt, offered: ReadonlyArray<string>): { readonly text: string; readonly calls: ReadonlyArray<EchoCall> } => {
  // A note the host added (a clock, a summary of older turns) is not a message to answer or a sum to work out.
  const prompt = { ...sent, content: sent.content.filter((message) => !(message.role === "user" && message.content.every((part) => part.type === "text" && isHostNote(part.text)))) }
  /** What the tool results ending at `at` say, as Echo answers from them: a helper's answer passed on as the helper's. */
  const answerFrom = (at: number): string => {
    let first = at
    while (first > 0 && prompt.content[first - 1]?.role === "tool") first--
    const parts = prompt.content.slice(first, at + 1).flatMap((message) => (message.role === "tool" ? message.content : []))
    const helped = parts.flatMap((part) => (part.type === "tool-result" && part.name === "delegate" && !part.isFailure && typeof part.result === "object" && part.result !== null && "answer" in part.result ? [String(part.result.answer)] : []))
    if (helped.length > 0) return `The helper answered: ${helped.join(" ")}`
    // A result of lookup or readResult (lesson 8) and a refused forget (lesson 9) are answered in words of their own;
    // any other, and any other failure, as the tool's.
    const results = parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))
    const paramsOf = paramsOfCall(prompt.content)
    const read = results.flatMap((part) => readingOf(part, paramsOf) ?? [])
    const all = results.flatMap((part) => (readingOf(part, paramsOf) === undefined ? [`${part.name} ${part.isFailure ? "failed: " : "says "}${JSON.stringify(part.result)}`] : []))
    if (read.length > 0 && all.length === 0) return read.join(" ")
    return [...read, `The ${all.length > 1 ? "tools" : "tool"} answered: ${all.join("; ")}.`].join(" ")
  }
  // Every message sent since its last answer: the turn's own, and any that steered it.
  const since = prompt.content.length - 1 - prompt.content.slice().reverse().findIndex((message) => message.role === "assistant" || message.role === "tool")
  const pending = prompt.content.slice(since > prompt.content.length - 1 ? 0 : since + 1).flatMap((message) =>
    message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : [])
  // Where "read more" reads on from, and whether a message asks for it: only where a result was cut short, or where
  // the tools of lesson 8 are offered, so "go on" anywhere else is a message like any other.
  const place = readOnFrom(prompt.content)
  const readsOn = (asked: string): boolean => /\b(?:read more|read on|go on)\b/i.test(asked) && (place !== undefined || offered.includes("lookup") || offered.includes("readResult"))
  // The skills the system text's catalogue lists (lesson 10), and those a result in the prompt has loaded.
  const system = prompt.content.flatMap((message) => (message.role === "system" ? [message.content] : []))[0] ?? ""
  const listed = listedIn(system)
  const loaded = prompt.content.flatMap((message) => (message.role === "tool" ? message.content : [])).flatMap((part) => (part.type === "tool-result" ? loadedBy(part) ?? [] : []))
  const callFor = (asked: string): ReadonlyArray<EchoCall> => {
    // "Use convert without loading": a call of the units skill's tool whether or not it is offered, as a model that
    // skips the load would make. It goes before the catalogue's rule, which the word "convert" would wake.
    if (UNLOADED_CALL.test(asked) && offered.includes(LOAD_SKILL)) return [{ name: "convert", params: { value: 5, from: "km", to: "mi" } }]
    // "Load units", "load the haiku skill": the skill named, and no other the message's words might cover.
    const byName = namedToLoad(asked)
    if (byName !== undefined && offered.includes(LOAD_SKILL)) return [{ name: LOAD_SKILL, params: { skill: byName } }]
    // "How far is 5 km in miles?", "convert 26.2 miles to km": convert, where it is offered. It goes before the
    // catalogue's rule: a tool Echo was offered needs no load.
    const length = LENGTH.exec(asked)
    if (length !== null && offered.includes("convert")) return [{ name: "convert", params: { value: Number(length[1]), from: unitOf(length[2] ?? ""), to: unitOf(length[3] ?? "") } }]
    // A message a skill's line in the catalogue covers, while no result in the prompt has loaded that skill: load it
    // first. It goes before every rule under it: the catalogue says to load a skill before doing what it covers.
    const covering = listed.find((skill) => !loaded.includes(skill.id) && covers(skill, asked))
    if (covering !== undefined && offered.includes(LOAD_SKILL)) return [{ name: LOAD_SKILL, params: { skill: covering.id } }]
    // "Show a table of squares to 8", "show the times table of 7": a table, shown under an id named for what it holds.
    const table = /\btable of (squares|cubes)(?:\D+(\d+))?/i.exec(asked) ?? /\btimes table of (\d+)/i.exec(asked)
    if (table !== null && offered.includes("show")) return [showTable(table)]
    // "Ask a helper: …", "have a helper work out …": the rest is the helper's task.
    const handed = /\b(?:ask|have|get) a helper\b[\s:,-]*(?:to\s+)?(.+)/i.exec(asked)
    if (handed !== null && offered.includes("delegate")) return [{ name: "delegate", params: { task: handed[1]?.trim() ?? "" } }]
    // "Look up tides", "tell me about volcanoes": one of lookup's three topics, in lower case.
    const topic = /\b(?:look up|tell me about)\s+(?:the\s+)?(tides|volcanoes|honeybees)\b/i.exec(asked)
    if (topic !== null && offered.includes("lookup")) return [{ name: "lookup", params: { topic: topic[1]?.toLowerCase() ?? "" } }]
    // "Read more", "read on", "go on": the next part of the result last cut short, from where the last part stopped.
    if (readsOn(asked) && place?._tag === "At" && offered.includes("readResult")) return [{ name: "readResult", params: { result: place.result, from: place.from, length: READ_LENGTH } }]
    // "Forget my notes", "delete the notes", "clear all notes": forget, which asks a person before it deletes. It
    // goes before the rule under it, which takes any message about notes for a question.
    if (/\b(?:forget|delete|clear)\s+(?:all\s+(?:(?:my|the)\s+)?|my\s+|the\s+)notes\b/i.test(asked) && offered.includes("forget")) return [{ name: "forget", params: {} }]
    if (/\b(notes?|what did i ask you to remember)\b/i.test(asked) && offered.includes("recall")) return [{ name: "recall", params: {} }]
    const sum = /(-?\d+(?:\.\d+)?)\s*([-+*x×/÷])\s*(-?\d+(?:\.\d+)?)/.exec(asked)
    if (sum !== null && offered.includes("calculator")) return [{ name: "calculator", params: { a: Number(sum[1]), op: OPS[sum[2] ?? "+"] ?? "+", b: Number(sum[3]) } }]
    const note = /\bremember (?:that )?(.+)/i.exec(asked)
    if (note !== null && offered.includes("remember")) return [{ name: "remember", params: { note: note[1]?.trim() ?? "" } }]
    return []
  }
  const working = (calls: ReadonlyArray<EchoCall>) => ({ text: calls.length > 1 ? `Let me use ${calls.length} tools.` : "Let me work that out.", calls })
  const end = prompt.content.length - 1
  if (prompt.content[end]?.role === "tool") {
    // The results the prompt ends with. One that loaded a skill is not the end of the turn: the next step offers the
    // skill's tools, so the turn's messages are read again for a call they ask for that the turn has not made.
    let first = end
    while (first > 0 && prompt.content[first - 1]?.role === "tool") first--
    const results = prompt.content.slice(first).flatMap((message) => (message.role === "tool" ? message.content : [])).flatMap((part) => (part.type === "tool-result" ? [part] : []))
    if (results.some((part) => loadedBy(part) !== undefined)) {
      // The turn so far: everything after Echo's last answer, an answer being a message of its own with no call.
      const answered = prompt.content.findLastIndex((message) => message.role === "assistant" && !message.content.some((part) => part.type === "tool-call"))
      const turn = prompt.content.slice(answered + 1)
      const asking = turn.flatMap((message) => (message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))
      const made = new Set(turn.flatMap((message) => (message.role === "assistant" ? message.content : [])).flatMap((part) => (part.type === "tool-call" ? [`${part.name} ${JSON.stringify(part.params)}`] : [])))
      const more = asking.flatMap(callFor).filter((call) => !made.has(`${call.name} ${JSON.stringify(call.params)}`))
      if (more.length > 0) return working(more)
      // Nothing more to call. A load the message did not ask for by name, with the haiku skill loaded, is followed
      // by an answer in the skill's form; any other is answered as loaded.
      if (loaded.includes(HAIKU_SKILL) && results.every((part) => loadedBy(part) !== undefined) && !asking.some((asked) => namedToLoad(asked) !== undefined)) return { text: HAIKU, calls: [] }
    }
    return { text: answerFrom(end), calls: [] }
  }
  const calls = pending.flatMap(callFor)
  if (calls.length > 0) return working(calls)
  // "Read more" with no call to make: nothing was cut short, the last part reached the end, or the tool is not offered.
  if (pending.some(readsOn)) {
    return {
      text: place === undefined ? "There is nothing to read on from: look something up first."
        : place._tag === "End" ? "That was the end of it."
          : "I have no tool to read on: readResult is not among my tools.",
      calls: [],
    }
  }
  // Messages that steered the turn after its tools answered: answer from the results, and say what was heard.
  if (prompt.content[since]?.role === "tool" && pending.length > 0) {
    return { text: `${answerFrom(since)} You also said: ${pending.map((text) => `"${clip(text, 40)}"`).join(", ")}.`, calls: [] }
  }
  // An answer of Echo's own, with no tool to call and no result to pass on: in the haiku skill's form while it is loaded.
  if (loaded.includes(HAIKU_SKILL)) return { text: HAIKU, calls: [] }
  return { text: echoReply(toChatMessages(sent)), calls: [] }
}

/** This page load's ids for Echo's tool calls. */
const echoCallId = callIds("echo-call")

/** Echo, loaded. `callId` mints the ids of its tool calls: a test passes its own to make two pages mint the same ones. */
export const loadEcho = (callId: () => string = echoCallId): LoadedModel => {
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
      const asked = calls.map((call) => ({ type: "tool-call" as const, id: callId(), name: call.name, params: call.params }))
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
