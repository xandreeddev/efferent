// What the Context tab shows, worked out from what the page heard: the
// conversation's journal, what memory built for each model call, each
// prompt the model received, and what the program told the chat. Pure: the
// page feeds it traces (`record`), and asks for one turn's view (`viewOf`).
// A turn may call the model several times (a turn with tools is a loop over
// steps), so its steps are built from what happened, call by call.
import { Option } from "effect"
import { assistantMessageEvent, messageOf, toolResultEvent, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens } from "@xandreed/sdk/kernel"
import type { Reported, Said, Trace } from "./runtime.ts"
import { cameFrom, saidOfStored } from "./said.ts"

/** One line of the events log. */
export interface LogEntry {
  /** Milliseconds since the board started. */
  readonly at: number
  readonly kind: "record" | "live" | "memory" | "prompt" | "usage" | "chat" | "program"
  readonly title: string
  readonly detail: string
  readonly turn: number
  readonly seq: Option.Option<number>
  readonly tags: ReadonlyArray<string>
}

/** What memory built for one model call: the messages, from the journal as it was up to record `upTo`. */
interface ContextSeen {
  readonly upTo: number
  readonly messages: ReadonlyArray<Said>
}

/** Everything heard about one conversation. Per turn, one entry per model call, in order. */
export interface Board {
  readonly session: string
  readonly records: ReadonlyArray<StoredEvent>
  readonly contexts: ReadonlyMap<number, ReadonlyArray<ContextSeen>>
  readonly prompts: ReadonlyMap<number, ReadonlyArray<ReadonlyArray<Said>>>
  /** The tools offered with each prompt, by turn. */
  readonly offered: ReadonlyMap<number, ReadonlyArray<ReadonlyArray<string>>>
  readonly usage: ReadonlyMap<number, ReadonlyArray<Reported>>
  /** Pieces streamed, by turn, per model call. */
  readonly pieces: ReadonlyMap<number, ReadonlyArray<number>>
  /** The newest entries of the events log, at most LOG_LIMIT. */
  readonly log: ReadonlyArray<LogEntry>
  /** How many entries were ever logged, those dropped included. */
  readonly logged: number
}

export const emptyBoard = (session: string): Board => ({
  session, records: [], contexts: new Map(), prompts: new Map(), offered: new Map(), usage: new Map(), pieces: new Map(), log: [], logged: 0,
})

export const LOG_LIMIT = 400

const clip = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? ""

/** A record, in a few words. */
export const summaryOf = (record: Pick<StoredEvent, "name" | "data" | "tags" | "message">): string =>
  Option.match(messageOf(record), {
    onSome: (message) => clip(saidOfStored(message).text),
    onNone: () => {
      const data = record.data
      if (record.name === turnStartedEvent.name && typeof data === "object" && data !== null && "turn" in data) return `turn ${String(data.turn)} opened`
      if (record.name === turnEndedEvent.name && typeof data === "object" && data !== null && "outcome" in data) {
        const outcome = data.outcome
        const tag = typeof outcome === "object" && outcome !== null && "_tag" in outcome ? String(outcome._tag) : "?"
        return `turn ${"turn" in data ? String(data.turn) : "?"} closed: ${tag}`
      }
      return clip(JSON.stringify(data) ?? "")
    },
  })

const withEntry = (board: Board, entry: LogEntry): Board => ({ ...board, log: [...board.log, entry].slice(-LOG_LIMIT), logged: board.logged + 1 })

const append = <V>(map: ReadonlyMap<number, ReadonlyArray<V>>, key: number, value: V): ReadonlyMap<number, ReadonlyArray<V>> =>
  new Map(map).set(key, [...(map.get(key) ?? []), value])

export const tokensOf = (messages: ReadonlyArray<Said>): number => messages.reduce((sum, message) => sum + estimateTokens(message.text), 0)

/** The board after one more trace, heard `at` ms after it started. Events of another conversation are left out. */
export const record = (board: Board, trace: Trace, at: number): Board => {
  const base = { at, seq: Option.none<number>(), tags: [] as ReadonlyArray<string> }
  switch (trace._tag) {
    case "Event": {
      const event = trace.event
      if (event.session !== board.session) return board
      if (event._tag === "Stored") {
        const { session: _session, _tag: _ignored, ...stored } = event
        return withEntry({ ...board, records: [...board.records, stored] }, {
          ...base, kind: "record", turn: event.turn, seq: Option.some(event.seq), tags: event.tags,
          title: `stored #${event.seq} ${event.name}`, detail: json(event.message === undefined ? event.data : { data: event.data, message: event.message }),
        })
      }
      return withEntry(board, { ...base, kind: "live", turn: event.turn ?? 0, tags: event.tags, title: `live ${event.name}`, detail: json(event.data) })
    }
    case "Context":
      return withEntry({ ...board, contexts: append(board.contexts, trace.turn, { upTo: trace.upTo, messages: trace.messages }) }, {
        ...base, kind: "memory", turn: trace.turn, title: `memory gave ${trace.messages.length} message${trace.messages.length === 1 ? "" : "s"}`, detail: json(trace.messages),
      })
    case "Prompt": {
      const pieces = append(board.pieces, trace.turn, 0)
      return withEntry({ ...board, prompts: append(board.prompts, trace.turn, trace.messages), offered: append(board.offered, trace.turn, trace.tools), pieces }, {
        ...base, kind: "prompt", turn: trace.turn,
        title: `prompt sent: ${trace.messages.length} messages, ~${tokensOf(trace.messages)} tokens${trace.tools.length > 0 ? `, ${trace.tools.length} tools offered` : ""}`,
        detail: json(trace.tools.length > 0 ? { messages: trace.messages, tools: trace.tools } : trace.messages),
      })
    }
    case "Usage":
      return withEntry({ ...board, usage: append(board.usage, trace.turn, trace.usage) }, {
        ...base, kind: "usage", turn: trace.turn, title: "the provider reported its usage", detail: json(trace.usage),
      })
    case "Piece": {
      const counts = board.pieces.get(trace.turn) ?? [0]
      const last = counts.at(-1) ?? 0
      const pieces = new Map(board.pieces).set(trace.turn, [...counts.slice(0, -1), last + 1])
      // One log line per model call's stream, not one per piece.
      return last === 0
        ? withEntry({ ...board, pieces }, { ...base, kind: "chat", turn: trace.turn, title: "chat.stream: the answer starts streaming", detail: trace.text })
        : { ...board, pieces }
    }
    case "Reply":
      return withEntry(board, { ...base, kind: "chat", turn: trace.turn, title: "chat.reply", detail: trace.text })
    case "Failed":
      return withEntry(board, { ...base, kind: "chat", turn: trace.turn, title: "chat.fail", detail: trace.message })
    case "Status":
      return withEntry(board, { ...base, kind: "chat", turn: trace.turn, title: `chat.status: ${trace.text}`, detail: trace.text })
    case "Ended":
      return withEntry(board, { ...base, kind: "program", turn: 0, title: "the program stopped", detail: trace.reason })
  }
}

// ── one turn's view ─────────────────────────────────────────────────────────

export type StepState = "done" | "now" | "todo" | "failed" | "skipped"
export type StepKind = "opened" | "stored-message" | "steered" | "context" | "prompt" | "streamed" | "stored-answer" | "tools" | "closed"

export interface StepView {
  /** Unique in the turn: the kind, and the model call it belongs to (`context-2`). */
  readonly id: string
  readonly kind: StepKind
  /** The model call it belongs to, from 1; 0 for the turn's own steps. */
  readonly call: number
  readonly label: string
  /** What the program wrote for it. */
  readonly code: string
  readonly detail: string
  readonly state: StepState
  /** The records it wrote or read, to light up. */
  readonly seqs: ReadonlyArray<number>
  /** Where to look. */
  readonly column: "journal" | "memory" | "prompt"
}

/** How a record stands for the model call shown. */
export type RecordUse = "in-context" | "left-out" | "later" | "not-conversation"

export interface JournalRow {
  readonly seq: number
  readonly turn: number
  readonly name: string
  readonly tags: ReadonlyArray<string>
  readonly summary: string
  readonly role: Option.Option<string>
  readonly use: RecordUse
  /** Written by the turn shown. */
  readonly ofTurn: boolean
  readonly payload: string
}

export interface MemoryRow {
  readonly role: string
  readonly text: string
  readonly tokens: number
  readonly seq: Option.Option<number>
}

export interface PromptRow {
  readonly role: string
  readonly text: string
  readonly tokens: number
  /** Where it came from: the program's code (the system text, never stored), memory (a record), or added by the code after the context. */
  readonly source: "code" | "memory" | "added"
  readonly seq: Option.Option<number>
  /** The same as the previous prompt up to here: a provider's cache can reuse it. */
  readonly reused: boolean
}

/** One model call of a turn: what memory gave it, and the prompt it received. */
export interface CallView {
  readonly call: number
  readonly memory: Option.Option<ReadonlyArray<MemoryRow>>
  readonly prompt: Option.Option<ReadonlyArray<PromptRow>>
  readonly promptTokens: number
  readonly reusedTokens: number
  readonly usage: Option.Option<Reported>
  /** The tools offered with the prompt: code, never stored. */
  readonly tools: ReadonlyArray<string>
  /** The journal as this call saw it. */
  readonly journal: ReadonlyArray<JournalRow>
}

export interface TurnView {
  readonly turn: number
  readonly closed: Option.Option<string>
  readonly steps: ReadonlyArray<StepView>
  readonly calls: ReadonlyArray<CallView>
}

/** The turns of the conversation, in order. */
export const turnsOf = (board: Board): ReadonlyArray<number> =>
  board.records.flatMap((record) => (record.name === turnStartedEvent.name ? [record.turn] : []))

/** Which record each context message came from: matched from the newest back, so a repeated text finds its own record. */
const linkContext = (records: ReadonlyArray<StoredEvent>, messages: ReadonlyArray<Said>): ReadonlyArray<Option.Option<number>> => {
  const pool = records.flatMap((record) => Option.match(messageOf(record), { onNone: () => [], onSome: (message) => [{ seq: record.seq, said: saidOfStored(message) }] }))
  const used = new Set<number>()
  const links: Array<Option.Option<number>> = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const found = pool.findLast((entry) => !used.has(entry.seq) && cameFrom(message, entry.said))
    if (found !== undefined) used.add(found.seq)
    links[index] = Option.fromNullishOr(found?.seq)
  }
  return links
}

const outcomeOfRecord = (record: StoredEvent): string => {
  const data = record.data
  if (typeof data === "object" && data !== null && "outcome" in data) {
    const outcome = data.outcome
    if (typeof outcome === "object" && outcome !== null && "_tag" in outcome) {
      return "reason" in outcome && typeof outcome.reason === "string" ? `${String(outcome._tag)}: ${outcome.reason}` : String(outcome._tag)
    }
  }
  return "closed"
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The journal as one model call saw it: what memory took, what it left out, what came later. */
const journalFor = (board: Board, turn: number, context: Option.Option<ContextSeen>, inContext: ReadonlySet<number>): ReadonlyArray<JournalRow> => {
  const upTo = Option.match(context, { onNone: () => Infinity, onSome: (seen) => seen.upTo })
  return board.records.map((record): JournalRow => {
    const role = Option.map(messageOf(record), (message) => saidOfStored(message).role)
    const use: RecordUse = Option.isNone(role) ? "not-conversation"
      : record.seq > upTo ? "later"
        : Option.isNone(context) || inContext.has(record.seq) ? "in-context" : "left-out"
    return {
      seq: record.seq, turn: record.turn, name: record.name, tags: record.tags, summary: summaryOf(record), role, use,
      ofTurn: record.turn === turn, payload: json(record.message === undefined ? record.data : { data: record.data, message: record.message }),
    }
  })
}

const callViewOf = (board: Board, turn: number, index: number, previous: Option.Option<ReadonlyArray<Said>>): CallView => {
  const context = Option.fromNullishOr(board.contexts.get(turn)?.[index])
  const promptSaid = Option.fromNullishOr(board.prompts.get(turn)?.[index])
  const memory = Option.map(context, ({ upTo, messages }) => {
    const links = linkContext(board.records.filter((record) => record.seq <= upTo), messages)
    return messages.map((message, at): MemoryRow => ({ role: message.role, text: message.text, tokens: estimateTokens(message.text), seq: links[at] ?? Option.none() }))
  })
  const fromMemory: ReadonlyArray<MemoryRow & { readonly key: string }> = Option.match(context, {
    onNone: () => [],
    onSome: ({ messages }) => messages.map((message, at) => ({ ...Option.getOrElse(Option.flatMap(memory, (rows) => Option.fromNullishOr(rows[at])), () => ({ role: message.role, text: message.text, tokens: 0, seq: Option.none<number>() })), key: message.key })),
  })
  const inContext = new Set(fromMemory.flatMap((row) => Option.toArray(row.seq)))
  const prompt = Option.map(promptSaid, (messages) => {
    let next = 0
    let prefix = true
    return messages.map((message, at): PromptRow => {
      prefix = prefix && Option.match(previous, { onNone: () => false, onSome: (before) => before[at] !== undefined && before[at]!.key === message.key })
      const tokens = estimateTokens(message.text)
      const shown = { role: message.role, text: message.text, tokens, reused: prefix }
      if (at === 0 && message.role === "system") return { ...shown, source: "code", seq: Option.none() }
      const row = fromMemory[next]
      if (row !== undefined && row.key === message.key) {
        next++
        return { ...shown, source: "memory", seq: row.seq }
      }
      return { ...shown, source: "added", seq: Option.none() }
    })
  })
  const rows: ReadonlyArray<PromptRow> = Option.getOrElse(prompt, (): ReadonlyArray<PromptRow> => [])
  return {
    call: index + 1,
    memory,
    prompt,
    promptTokens: rows.reduce((sum: number, row: PromptRow) => sum + row.tokens, 0),
    reusedTokens: rows.reduce((sum: number, row: PromptRow) => sum + (row.reused ? row.tokens : 0), 0),
    usage: Option.fromNullishOr(board.usage.get(turn)?.[index]),
    tools: board.offered.get(turn)?.[index] ?? [],
    journal: journalFor(board, turn, context, inContext),
  }
}

export const viewOf = (board: Board, turn: number): TurnView => {
  const ofTurn = board.records.filter((record) => record.turn === turn)
  const started = Option.fromNullishOr(board.records.find((record) => record.name === turnStartedEvent.name && record.turn === turn))
  const ended = Option.fromNullishOr(ofTurn.find((record) => record.name === turnEndedEvent.name))
  const users = ofTurn.filter((record) => record.name === userMessageEvent.name)
  const answers = ofTurn.filter((record) => record.name === assistantMessageEvent.name)
  const results = ofTurn.filter((record) => record.name === toolResultEvent.name)
  const callCount = Math.max(board.prompts.get(turn)?.length ?? 0, board.contexts.get(turn)?.length ?? 0, answers.length)

  // The prompt before each call: the turn's previous call, or the previous turn's last.
  const lastOf = (t: number) => Option.fromNullishOr(board.prompts.get(t)?.at(-1))
  const calls: Array<CallView> = []
  for (let index = 0; index < Math.max(1, callCount); index++) {
    const previous = index === 0 ? lastOf(turn - 1) : Option.fromNullishOr(board.prompts.get(turn)?.[index - 1])
    calls.push(callViewOf(board, turn, index, previous))
  }

  const seqOf = (found: Option.Option<StoredEvent>) => Option.match(found, { onNone: () => [], onSome: (one) => [one.seq] })
  type Raw = Omit<StepView, "state"> & { readonly happened: boolean }
  const raw: Array<Raw> = []
  const first = Option.fromNullishOr(users[0])
  raw.push({
    id: "opened", kind: "opened", call: 0, label: "Turn opened", code: "sessions.open(chat.session)", column: "journal", happened: Option.isSome(started), seqs: seqOf(started),
    detail: Option.match(started, { onNone: () => "Opening the turn.", onSome: (one) => `Record #${one.seq}, ${one.name}. The turn's scope is open; it closes when the scope ends.` }),
  })
  raw.push({
    id: "stored-message", kind: "stored-message", call: 0, label: "Message stored", code: "session.append(userMessage(message))", column: "journal", happened: Option.isSome(first), seqs: seqOf(first),
    detail: Option.match(first, { onNone: () => "Your message goes into the journal first.", onSome: (one) => `Record #${one.seq}, tagged ${one.tags.join(", ")}. It is in the journal before the model sees anything.` }),
  })
  const pieces = board.pieces.get(turn) ?? []
  const many = callCount > 1
  for (let index = 0; index < Math.max(1, callCount); index++) {
    const n = index + 1
    const view = calls[index]!
    const answer = Option.fromNullishOr(answers[index])
    const at = (label: string) => (many ? `${label} (${n})` : label)
    const memoryCount = Option.match(view.memory, { onNone: () => 0, onSome: (rows) => rows.length })
    const leftOut = view.journal.filter((row) => row.use === "left-out").length
    const promptRows = Option.getOrElse(view.prompt, (): ReadonlyArray<PromptRow> => [])
    const added = promptRows.filter((row) => row.source === "added").length
    const inContext = Option.match(view.memory, { onNone: () => [], onSome: (rows) => rows.flatMap((row) => Option.toArray(row.seq)) })
    // Steer messages: users stored in this turn after the previous call's results, before this call.
    if (index > 0) {
      const before = Option.match(Option.fromNullishOr(answers[index - 1]), { onNone: () => Infinity, onSome: (one) => one.seq })
      const until = Option.match(answer, { onNone: () => Infinity, onSome: (one) => one.seq })
      const steers = users.filter((record) => record.seq > before && record.seq < until)
      if (steers.length > 0) {
        raw.push({
          id: `steered-${n}`, kind: "steered", call: n, label: at("Steered"), code: "chat.drain", column: "journal", happened: true, seqs: steers.map((record) => record.seq),
          detail: `${plural(steers.length, "message")} you sent while it worked joined the turn: ${steers.map((record) => `#${record.seq}`).join(", ")}.`,
        })
      }
    }
    raw.push({
      id: `context-${n}`, kind: "context", call: n, label: at("Memory built the context"), code: "memory.context(session)", column: "memory", happened: Option.isSome(view.memory), seqs: inContext,
      detail: Option.isSome(view.memory)
        ? `${plural(memoryCount, "message")} from the journal${leftOut > 0 ? `; ${leftOut} left out by memory` : ", nothing left out"}.`
        : "Memory reads the journal and picks what the model sees.",
    })
    raw.push({
      id: `prompt-${n}`, kind: "prompt", call: n, label: at("Prompt sent"), code: "model.streamText({ prompt })", column: "prompt", happened: Option.isSome(view.prompt), seqs: inContext,
      detail: Option.isSome(view.prompt)
        ? `The system text from your code, ${memoryCount} from memory${added > 0 ? `, ${added} added by your code` : ""}: about ${view.promptTokens} tokens, ${view.reusedTokens} the same as the prompt before.`
        : "The prompt is built fresh: the system text, then the context.",
    })
    const streamed = pieces[index] ?? 0
    raw.push({
      id: `streamed-${n}`, kind: "streamed", call: n, label: at("Answer streamed"), code: "chat.stream(piece)", column: "prompt", happened: streamed > 0 || Option.isSome(answer), seqs: [],
      detail: streamed > 0 ? `${plural(streamed, "piece")} streamed to the chat as they arrived.` : Option.isSome(answer) ? "The model streamed no text: it only called tools." : "Each piece goes to the chat as it arrives.",
    })
    const asked = Option.match(answer, { onNone: () => [] as ReadonlyArray<string>, onSome: (one) => (one.message?._tag === "Assistant" ? one.message.toolCalls.map((call) => String(call.id)) : []) })
    raw.push({
      id: `stored-answer-${n}`, kind: "stored-answer", call: n, label: at(asked.length > 0 ? "Calls stored" : "Answer stored"), code: "session.append(assistantMessage(…))", column: "journal", happened: Option.isSome(answer), seqs: seqOf(answer),
      detail: Option.match(answer, {
        onNone: () => "The answer goes into the journal, for the next call's context.",
        onSome: (one) => asked.length > 0 ? `Record #${one.seq}: the model asked for ${plural(asked.length, "tool call")}.` : `Record #${one.seq}. The next turn's memory can read it.`,
      }),
    })
    if (asked.length > 0) {
      const done = results.filter((record) => record.message?._tag === "ToolResult" && asked.includes(String(record.message.id)))
      const failed = done.filter((record) => record.message?._tag === "ToolResult" && record.message.isFailure).length
      raw.push({
        id: `tools-${n}`, kind: "tools", call: n, label: at("Tools ran"), code: "toolkit.handle(call.name, call.params)", column: "journal", happened: done.length === asked.length, seqs: done.map((record) => record.seq),
        detail: done.length === 0 ? `Running ${plural(asked.length, "tool call")}.`
          : `${plural(done.length, "result")} stored${failed > 0 ? `, ${failed} of them failures the model reads` : ""}: ${done.map((record) => `#${record.seq}`).join(", ")}. Then the model is asked again.`,
      })
    }
  }
  raw.push({
    id: "closed", kind: "closed", call: 0, label: "Turn closed", code: "the scope ends", column: "journal", happened: Option.isSome(ended), seqs: seqOf(ended),
    detail: Option.match(ended, { onNone: () => "The turn closes when its scope ends: answered, failed or stopped.", onSome: (one) => `Record #${one.seq}: ${outcomeOfRecord(one)}.` }),
  })

  const closed = Option.map(ended, outcomeOfRecord)
  const isClosed = Option.isSome(ended)
  const failed = Option.match(closed, { onNone: () => false, onSome: (text) => !text.startsWith("Completed") })
  const firstMissing = raw.findIndex((step) => !step.happened)
  const steps = raw.map(({ happened, ...step }, index): StepView => ({
    ...step,
    state: step.kind === "closed" && isClosed && failed ? "failed"
      : happened ? "done"
        : isClosed ? "skipped"
          : index === firstMissing ? "now" : "todo",
  }))
  return { turn, closed, steps, calls }
}
