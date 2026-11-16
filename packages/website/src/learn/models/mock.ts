// "Echo": a model that needs no download, so every part of the lesson (chat,
// streaming, events, the context inspector) works on any device. It is a
// scripted stand-in, and says so: it answers only from the messages it was
// sent, which is what makes it useful for seeing what an agent's memory holds.
import { Effect, Stream } from "effect"
import type { Prompt } from "effect/ai"
import { APPROVAL_REFUSED, CANCEL_TASK, catalogue, EDIT_FILE, factsNote, FORGET_FACT, LIST_FILES, LOAD_SKILL, READ_FILE, REMEMBER_FACT, START_TASK, WRITE_FILE } from "@xandreed/sdk/kernel"
import type { ChatMessage } from "../prompt-map.ts"
import { reportIn } from "../reports.ts"
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
/**
 * The first line of the kernel's note of remembered facts (lesson 11), word for word: a message that starts with
 * it and frames its lines lists the facts a memory wrapper added for this request.
 */
const FACTS_HEAD = factsNote([]).split("\n")[0] ?? ""
const FACTS_OPEN = `${FACTS_HEAD}\n<remembered-facts>\n`
const FACTS_CLOSE = "\n</remembered-facts>"
/** Whether a text is the kernel's note of remembered facts: its first line, then the frame, and nothing after it. */
const isFactsNote = (text: string): boolean => text.startsWith(FACTS_OPEN) && text.endsWith(FACTS_CLOSE)
/** The note of remembered facts (lesson 11): code's, as the clock's is, and not a message of the conversation. */
const isFacts = (message: ChatMessage): boolean => message.role === "user" && isFactsNote(message.content)
/** What a wrapper added for this request and never stored: the clock's note, or the facts'. */
const isAdded = (message: ChatMessage): boolean => isClock(message) || isFacts(message)
/**
 * A background task's report (lesson 17), known by the kernel's words: a message of the conversation, but not one
 * the person said, and no note that older turns were condensed.
 */
const isReport = (message: ChatMessage): boolean => message.role === "user" && reportIn(message.content) !== undefined
const isLedger = (message: ChatMessage): boolean => message.role === "user" && message.content.startsWith("[Host note:") && !isAdded(message) && !isReport(message)
const isNote = (message: ChatMessage): boolean => isLedger(message) || isAdded(message) || isReport(message)
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

/**
 * Lesson 13's rule: one message that says what something is, then asks about it in the next sentence, under the
 * same name ("The meeting is on Tuesday. When is the meeting?", "The keys are under the mat. Where are the
 * keys?"). It is answered with the first sentence, which says it. A question about another name, or the two
 * sentences in another form ("Tuesday is the day of the meeting."), is no such message.
 */
const STATED = /^\s*(the\s+([a-z]+(?:\s+[a-z]+)*?)\s+(?:is|are)\s+[^.?!]+)\.\s+(?:when|where|what|who)\s+(?:is|are)\s+the\s+([a-z]+(?:\s+[a-z]+)*?)\s*\?\s*$/i

/** The sentence a message stated before asking about it (lesson 13), or none. */
const statedIn = (asked: string): string | undefined => {
  const match = STATED.exec(asked)
  return match !== null && match[2]?.toLowerCase() === match[3]?.toLowerCase() ? `${match[1]}.` : undefined
}

/** What Echo says, from the messages the agent sent it. */
export const echoReply = (messages: ReadonlyArray<ChatMessage>): string => {
  const request = messages.findLast((message) => message.role === "user")?.content ?? ""
  if (request.includes("<conversation-transcript>")) return echoSummary(request)
  const system = messages.find((message) => message.role === "system")
  const clock = messages.findLast(isClock)
  const turns = messages.filter((message) => message.role !== "system" && !isAdded(message))
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
  // Lesson 13: a message that states something, then asks about it, is answered with what it stated. Without
  // this rule Echo repeats the message, which holds the answer too: a grader could not tell the two apart.
  const stated = statedIn(last)
  if (stated !== undefined) return stated
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

/** A fact as the kernel's note lists it (lesson 11): its id, and its text. */
interface ListedFact {
  readonly id: string
  readonly text: string
}

/**
 * The facts a prompt's note of remembered facts lists: read from the last user message that is the kernel's note
 * (its first line, then the frame), a line each, `id: text`. No other message is read: not what the user typed,
 * not a call's parameters, not a tool's result.
 */
const factsIn = (messages: Prompt.Prompt["content"]): ReadonlyArray<ListedFact> => {
  const note = messages
    .flatMap((message) => (message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))
    .findLast(isFactsNote)
  if (note === undefined) return []
  return note.slice(FACTS_OPEN.length, note.length - FACTS_CLOSE.length).split("\n").flatMap((line) => {
    const entry = /^(f[1-9][0-9]*): (.+)$/.exec(line)
    return entry === null ? [] : [{ id: entry[1] ?? "", text: entry[2] ?? "" }]
  })
}

/**
 * The words a message and a fact are matched by: those of four letters or more, in lower case, but "user", which
 * every fact Echo writes holds ("The user's name is Ana.").
 */
const factWords = (text: string): ReadonlyArray<string> => (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((word) => word !== "user")

/** The listed fact that shares the most words with a text: the first listed among equals, and none when no fact shares one. */
const factAbout = (facts: ReadonlyArray<ListedFact>, text: string): ListedFact | undefined => {
  const asked = new Set(factWords(text))
  const shared = facts.map((fact) => new Set(factWords(fact.text).filter((word) => asked.has(word))).size)
  const most = Math.max(0, ...shared)
  return most === 0 ? undefined : facts[shared.indexOf(most)]
}

/**
 * The fact a message tells Echo to remember (lesson 11), as a sentence that reads on its own, for these messages
 * and no other: "my name is X" ("The user's name is X."), "I live in X" ("The user lives in X.") and "remember
 * that X" ("The user said: X."), X running to the first full stop, comma or other mark for the first two and to
 * the message's end for the third. A question, a message that ends with a question mark, tells it nothing.
 */
const factSaid = (asked: string): string | undefined => {
  if (/\?\s*$/.test(asked)) return undefined
  const name = /\bmy name is\s+([^.!?,;:]+)/i.exec(asked)?.[1]?.trim()
  if (name !== undefined && name.length > 0) return `The user's name is ${name}.`
  const home = /\bI live in\s+([^.!?,;:]+)/i.exec(asked)?.[1]?.trim()
  if (home !== undefined && home.length > 0) return `The user lives in ${home}.`
  const told = /\bremember that\s+([^]+?)[.!\s]*$/i.exec(asked)?.[1]?.trim()
  return told !== undefined && told.length > 0 ? `The user said: ${told}.` : undefined
}

/** What follows "forget" in a message that asks Echo to forget a fact: one that starts with "forget" or "please forget". */
const toForget = (asked: string): string | undefined => /^\s*(?:please\s+)?forget\b([^]*)$/i.exec(asked)?.[1]

/** The id a message names to forget, written as a fact's id is: "forget f1". */
const idToForget = (rest: string): string | undefined => /^\s*(f[1-9][0-9]*)\b/i.exec(rest)?.[1]?.toLowerCase()

/** What Echo says when it is asked to forget and no listed fact shares a word with the message. */
const NO_SUCH_FACT = "I remember no fact about that."

/** A question about everything Echo remembers: "what do you remember", "what do you know". */
const ASKS_WHAT_IS_REMEMBERED = /\bwhat do you (?:remember|know)\b/i

/** The id a successful result of `rememberFact` gives. */
const rememberedBy = (part: ResultPart): string | undefined =>
  part.name === REMEMBER_FACT && !part.isFailure && typeof part.result === "object" && part.result !== null && "id" in part.result && typeof part.result.id === "string"
    ? part.result.id
    : undefined

/**
 * What Echo says of one result in words of its own. Of `lookup` or `readResult` (lesson 8): the first sentence of
 * what it was sent (of a part read on, the first whole one), and how much of the whole that is. Of a `forget` that
 * failed with the kernel's refusal, word for word (lesson 9): that nothing was deleted. Of a `loadSkill` that
 * loaded a skill (lesson 10): that it is loaded, without its instructions. Of a `convert` that answered a number:
 * the length it was asked about and the number to one decimal, with its unit, read from the call's parameters
 * (`paramsOf`). Of a `rememberFact` that stored a fact (lesson 11): that it will remember, and the fact's id.
 * Nothing for any other tool's result, or any other failure: those are answered as the tool's.
 */
const readingOf = (part: ResultPart, paramsOf: (id: string) => unknown): string | undefined => {
  if (part.name === "forget" && part.isFailure && part.result === APPROVAL_REFUSED) return NOT_APPROVED
  if (part.isFailure) return undefined
  const started = taskStartedBy(part)
  if (started !== undefined) return `Started task ${started}: its answer comes as a message of its own.`
  if (part.name === CANCEL_TASK && typeof part.result === "string") return part.result
  const file = fileReadingOf(part)
  if (file !== undefined) return file
  const loaded = loadedBy(part)
  if (loaded !== undefined) return `Loaded ${loaded}.`
  const remembered = rememberedBy(part)
  if (remembered !== undefined) return `I will remember that: it is fact ${remembered}.`
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

/**
 * What a file tool's result says in Echo's words (lesson 16), for a result that did not fail: a page `readFile`
 * returned (the file, the characters it holds, its start, and the message that reads on when more follows), the
 * paths `listFiles` gave (a few named, the rest counted), or what `writeFile` and `editFile` wrote. Nothing for
 * any other result: a failure is answered as the tool's, in the kernel's words.
 */
const fileReadingOf = (part: ResultPart): string | undefined => {
  const result: unknown = part.result
  if (part.isFailure || typeof result !== "object" || result === null) return undefined
  if (part.name === READ_FILE) {
    const page = pageIn(result)
    const path = "path" in result && typeof result.path === "string" ? result.path : undefined
    if (page === undefined || path === undefined) return undefined
    const more = page.to < page.total ? ` Say "read ${path} from ${page.to}" for the next part.` : ""
    return `I read ${path}, characters ${page.from} to ${page.to} of ${page.total}: "${clip(page.text)}"${more}`
  }
  if (part.name === LIST_FILES && "paths" in result && Array.isArray(result.paths) && "more" in result && typeof result.more === "number") {
    const paths = result.paths.map(String)
    if (paths.length === 0) return "There are no files there."
    const named = paths.length > 5 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ")
    const left = result.more > 0 ? `, and ${result.more} more were left out` : ""
    return `I see ${plural(paths.length, "file")}${left}: ${named}.`
  }
  if ((part.name === WRITE_FILE || part.name === EDIT_FILE) && "path" in result && typeof result.path === "string" && "characters" in result && typeof result.characters === "number") {
    return `I ${part.name === WRITE_FILE ? "wrote" : "changed"} ${result.path}: it holds ${plural(result.characters, "character")} now.`
  }
  return undefined
}

/** The task a successful result of `startTask` names (lesson 17). */
const taskStartedBy = (part: ResultPart): string | undefined =>
  part.name === START_TASK && !part.isFailure && typeof part.result === "object" && part.result !== null && "task" in part.result && typeof part.result.task === "string"
    ? part.result.task
    : undefined

/** "In the background, X", "start a task: X" (lesson 17): `startTask` with X, the rest of the message. */
const START_ASKED = /^\s*(?:in the background|start a task)\s*[,:]\s*([^]+?)\s*$/i
/** "Cancel task t1" (lesson 17): `cancelTask` with the id. */
const CANCEL_ASKED = /^\s*(?:please\s+)?cancel\s+(?:the\s+)?task\s+(\S+?)[.!]?\s*$/i

/**
 * What Echo answers in a report's turn (lesson 17): each report since its last answer, by the kernel's words, as
 * the task's id, how it ended and the first sentence of its answer or why it failed. A message of the person's
 * that the same turn took (one that waited behind the report) is quoted back after them, and asks for no tool.
 * Nothing for a prompt with no report since its last answer.
 */
const reportsAnswered = (sent: Prompt.Prompt): string | undefined => {
  const last = sent.content.findLastIndex((message) => message.role === "assistant" || message.role === "tool")
  const texts = sent.content.slice(last + 1).flatMap((message) => (message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))
  const reports = texts.flatMap((text) => reportIn(text) ?? [])
  if (reports.length === 0) return undefined
  const said = texts.filter((text) => !isHostNote(text))
  const answered = reports.map((report) => `Task ${report.task} ${report.outcome === "Finished" ? "finished" : "failed"}: ${firstSentence(report.text)}`).join(" ")
  return said.length === 0 ? answered : `${answered} You also said: ${said.map((text) => `"${clip(text, 40)}"`).join(", ")}.`
}

/** "List the files", "list files in notes": `listFiles`, with the folder when one is named. */
const LIST_ASKED = /^\s*list\s+(?:all\s+)?(?:the\s+)?files(?:\s+(?:in|of|under)\s+(\S+?))?[.!?]?\s*$/i
/**
 * "Read notes/todo.md", "read notes/long.md from 4000": `readFile`, from a character when one is named. A path holds
 * a dot or a slash with more after it, so "read more." is none.
 */
const READ_ASKED = /^\s*read\s+(?=\S*[./]\S)(\S+?)(?:\s+from\s+(\d+))?[.!?]?\s*$/i
/** "Write a.txt: hello": `writeFile`, with the text after the colon. */
const WRITE_ASKED = /^\s*write\s+(\S+?)\s*:\s*([^]*?)\s*$/i
/** "In notes/todo.md replace milk with eggs": `editFile`, the text to find and the text to put in its place. */
const EDIT_ASKED = /^\s*in\s+(\S+?),?\s+replace\s+([^]+?)\s+with\s+([^]+?)[.!]?\s*$/i

/**
 * The file tool a message asks for (lesson 16), each where its tool is offered, by the four phrasings above, each
 * anchored at the message's start. None for any other message.
 */
const fileCallFor = (asked: string, offered: ReadonlyArray<string>): EchoCall | undefined => {
  const list = LIST_ASKED.exec(asked)
  if (list !== null && offered.includes(LIST_FILES)) return { name: LIST_FILES, params: list[1] === undefined ? {} : { folder: list[1] } }
  const read = READ_ASKED.exec(asked)
  if (read !== null && offered.includes(READ_FILE)) return { name: READ_FILE, params: { path: read[1] ?? "", ...(read[2] === undefined ? {} : { from: Number(read[2]) }) } }
  const write = WRITE_ASKED.exec(asked)
  if (write !== null && offered.includes(WRITE_FILE)) return { name: WRITE_FILE, params: { path: write[1] ?? "", text: write[2] ?? "" } }
  const edit = EDIT_ASKED.exec(asked)
  if (edit !== null && offered.includes(EDIT_FILE)) return { name: EDIT_FILE, params: { path: edit[1] ?? "", find: edit[2] ?? "", replace: edit[3] ?? "" } }
  return undefined
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
 *
 * Lesson 11's rules, for facts, each asleep where its tool is not offered. They are placed after lesson 10's rules;
 * the orders that decide a message are said below. The facts Echo knows of are those the kernel's note of remembered
 * facts lists (`factsNote`: its first line, word for word, then the frame, a line each), in the last such note of the
 * prompt, and nothing else: not what the user typed, a call's parameters or a tool's result. A message that starts
 * with "forget" or "please forget" is forgetFact's, where it is offered: "forget f1" calls it with that id; any other
 * with the id of the listed fact that shares the most words with the message (words of four letters or more, but
 * "user"; the first listed among equals); with no such fact it calls nothing and is answered "I remember no fact
 * about that.". It goes before the next rule, which "Forget that my name is Ana." would wake, and before lesson 9's
 * forget rule, for a program that offers both tools. "My name is X", "I live in X" and "remember that X", in a
 * message that is no question, call rememberFact, where it is offered, with a sentence that reads on its own: "The
 * user's name is X.", "The user lives in X.", "The user said: X.". It goes before the sum's rule, so "Remember that 2
 * + 2 is 4." is a fact here. "What do you remember?" or "what do you know" calls recallFacts, a tool of the lesson's
 * `recall-tool` experiment, where it is offered. A rememberFact that stored a fact is answered "I will remember that:
 * it is fact f1."; one that failed, and every result of forgetFact, as the tool's. With no call to make and facts
 * listed, one message that ends with a question mark is answered from them: "what do you remember" or "what do you
 * know" with every listed fact, and any other with the listed fact that shares the most words with it ("I remember:
 * "…" That is fact f1."); a question that shares none is answered like any other message. `echoReply` reads past the
 * facts' note as it reads past the clock's: it is no message of the conversation, and no note that older turns were
 * condensed.
 *
 * Lesson 16's rules, for the workspace, each asleep where its tool is not offered, placed after lesson 11's rules and
 * before every rule of lessons 2 to 9, each anchored at the start of the message. "List the files" (or "list files
 * in notes") calls listFiles; "read X", where X holds a dot or a slash, calls readFile, and "read X from N" reads
 * from character N; "write X: text" calls writeFile with the text after the colon; "in X replace A with B" calls
 * editFile with A to find and B to put in its place. A path under notes/ is no question about notes, a number in a
 * text is no sum, and "remember" in a text is no note. A page that was read is answered with the file, its range and
 * its start, and the message that reads on when more follows; a list with its paths; a write or an edit with what
 * the file holds now. A file tool that failed is answered as the tool's, in the kernel's words.
 *
 * Lesson 17's rules, for background tasks. A task's report, known by the kernel's words (`reportText`), is answered
 * before every other rule and calls nothing: "Task t1 finished: " and its answer's first sentence, or "Task t1
 * failed: " and why, with a message of the person's that the same turn took quoted after it. "In the background,
 * X" and "start a task: X" call startTask with X, and "cancel task t1" calls cancelTask, each where its tool is
 * offered, anchored at the message's start, and ahead of every other rule. A startTask that started a task is
 * answered "Started task t1: its answer comes as a message of its own.", a cancelTask in its own words, and a
 * failure of either as the tool's.
 */
export const echoStep = (sent: Prompt.Prompt, offered: ReadonlyArray<string>): { readonly text: string; readonly calls: ReadonlyArray<EchoCall> } => {
  // A task's report (lesson 17) is answered before anything else, and calls nothing. It starts with a host note, which
  // every rule below reads past: in a report's turn they would read the last message the person typed, which may
  // be the one that started the task, and start it again.
  const reported = reportsAnswered(sent)
  if (reported !== undefined) return { text: reported, calls: [] }
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
  // The facts the kernel's note lists for this request (lesson 11): read from what was sent, the note included.
  const known = factsIn(sent.content)
  /** Whether a message asks to forget a fact, where the tool that forgets is offered. */
  const forgets = (asked: string): boolean => toForget(asked) !== undefined && offered.includes(FORGET_FACT)
  const callFor = (asked: string): ReadonlyArray<EchoCall> => {
    // "In the background, X", "start a task: X": startTask with X (lesson 17). "Cancel task t1": cancelTask. Each
    // anchored at the message's start, and ahead of every rule below: X may hold a sum, a topic to look up, a note
    // to remember or a path, and is the helper's to do.
    const start = START_ASKED.exec(asked)
    if (start !== null && offered.includes(START_TASK)) return [{ name: START_TASK, params: { task: start[1] ?? "" } }]
    const cancel = CANCEL_ASKED.exec(asked)
    if (cancel !== null && offered.includes(CANCEL_TASK)) return [{ name: CANCEL_TASK, params: { task: cancel[1] ?? "" } }]
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
    // "Forget f1", "forget my name": forgetFact, with the id the message names, else the id of the listed fact
    // that shares the most words with it. With no such fact there is nothing to call, and no rule under this one
    // is tried: "Forget that my name is Ana." is not a fact to remember.
    if (forgets(asked)) {
      const rest = toForget(asked) ?? ""
      const id = idToForget(rest) ?? factAbout(known, rest)?.id
      return id === undefined ? [] : [{ name: FORGET_FACT, params: { id } }]
    }
    // "My name is Ana.", "I live in Lisbon.", "Remember that the door is green.": a fact, as a sentence that reads
    // on its own. It goes before the sum's rule: "Remember that 2 + 2 is 4." is a fact where rememberFact is offered.
    const fact = factSaid(asked)
    if (fact !== undefined && offered.includes(REMEMBER_FACT)) return [{ name: REMEMBER_FACT, params: { fact } }]
    // "What do you remember?": the tool that reads the facts, where a lesson offers one (lesson 11's recall-tool).
    if (ASKS_WHAT_IS_REMEMBERED.test(asked) && offered.includes("recallFacts")) return [{ name: "recallFacts", params: {} }]
    // "List the files", "read notes/todo.md", "write a.txt: hello", "in notes/todo.md replace milk with eggs": the
    // file tools (lesson 16), each where it is offered. They go before the rules of lessons 2 to 9: a path under
    // notes/ is no question about notes, a number in a text is no sum, and "remember" in a text is no note.
    const file = fileCallFor(asked, offered)
    if (file !== undefined) return [file]
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
  // Asked to forget, with no call to make: no listed fact shares a word with the message.
  if (pending.some(forgets)) return { text: NO_SUCH_FACT, calls: [] }
  // Messages that steered the turn after its tools answered: answer from the results, and say what was heard.
  if (prompt.content[since]?.role === "tool" && pending.length > 0) {
    return { text: `${answerFrom(since)} You also said: ${pending.map((text) => `"${clip(text, 40)}"`).join(", ")}.`, calls: [] }
  }
  // One question, with facts listed for this request (lesson 11): answered from them, in fixed words that quote them.
  const question = pending.length === 1 && /\?\s*$/.test(pending[0] ?? "") ? pending[0] : undefined
  if (question !== undefined && known.length > 0) {
    if (ASKS_WHAT_IS_REMEMBERED.test(question)) return { text: `I remember ${plural(known.length, "fact")}: ${known.map((fact) => `"${fact.text}" (${fact.id})`).join(", ")}.`, calls: [] }
    const about = factAbout(known, question)
    if (about !== undefined) return { text: `I remember: "${about.text}" That is fact ${about.id}.`, calls: [] }
  }
  // An answer of Echo's own, with no tool to call and no result to pass on: in the haiku skill's form while it is loaded.
  if (loaded.includes(HAIKU_SKILL)) return { text: HAIKU, calls: [] }
  return { text: echoReply(toChatMessages(sent)), calls: [] }
}

/** This page load's ids for Echo's tool calls. */
const echoCallId = callIds("echo-call")

/**
 * Echo, loaded, named `name` in the answers it stores (a second Echo, a spare, is named apart). `callId` mints the
 * ids of its tool calls: a test passes its own to make two pages mint the same ones. `uses` is `"tools"` for
 * Echo as every lesson has it, and `"words"` for lesson 13's weaker candidate, `echo-no-tools`: an Echo that calls
 * no tool, even one it is offered, and answers every message in words, as it does with no tool offered.
 */
export const loadEcho = (callId: () => string = echoCallId, name: string = echoChoice.id, uses: "tools" | "words" = "tools"): LoadedModel => {
  // Each answer has its own stop (lesson 17: the chat's turn and a task's helper stream at once): a stream that is
  // cancelled ends with its reader and stops no other, and Stop stops every answer being written now.
  const writing = new Set<{ stopped: boolean }>()
  const model = makeBrowserModel(name, {
    generateText: (options) => Effect.sync(() => {
      const messages = toChatMessages(options.prompt)
      const reply = echoReply(messages)
      return settledParts(reply, usageOf(messages, reply)) as never
    }),
    streamText: (options) => {
      const messages = toChatMessages(options.prompt)
      const { text: reply, calls } = uses === "tools" && options.tools.length > 0 ? echoStep(options.prompt, options.tools.map((tool) => tool.name)) : { text: echoReply(messages), calls: [] }
      const asked = calls.map((call) => ({ type: "tool-call" as const, id: callId(), name: call.name, params: call.params }))
      return Stream.unwrap(Effect.acquireRelease(
        Effect.sync(() => {
          const answer = { stopped: false }
          writing.add(answer)
          return answer
        }),
        (answer) => Effect.sync(() => { writing.delete(answer) }),
      ).pipe(Effect.map((answer) => Stream.fromIterable(words(reply)).pipe(
        Stream.mapEffect((word) => Effect.sleep("35 millis").pipe(Effect.as(word))),
        Stream.takeWhile(() => !answer.stopped),
        Stream.map(streamDelta),
        (deltas) => Stream.concat(Stream.concat(Stream.make(streamStart), deltas), Stream.suspend(() => Stream.fromIterable([streamEnd, ...(answer.stopped ? [] : asked), streamFinish(usageOf(messages, reply))]))),
      )))) as never
    },
  }, "native")
  return { choice: echoChoice, model, interrupt: () => { writing.forEach((answer) => { answer.stopped = true }) }, dispose: () => {} }
}
