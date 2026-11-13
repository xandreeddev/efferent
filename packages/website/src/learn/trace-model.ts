// What the Context tab shows, worked out from what the page heard: the
// conversation's journal, what memory built for each turn, each prompt the
// model received, and what the program told the chat. Pure: the page feeds
// it traces (`record`), and asks for one turn's view (`viewOf`).
import { Option } from "effect"
import { assistantMessageEvent, messageOf, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens } from "@xandreed/sdk/kernel"
import type { Reported, Said, Trace } from "./runtime.ts"

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

/** Everything heard about one conversation. */
export interface Board {
  readonly session: string
  readonly records: ReadonlyArray<StoredEvent>
  readonly contexts: ReadonlyMap<number, { readonly upTo: number; readonly messages: ReadonlyArray<Said> }>
  readonly prompts: ReadonlyMap<number, ReadonlyArray<Said>>
  readonly usage: ReadonlyMap<number, Reported>
  readonly pieces: ReadonlyMap<number, number>
  /** The newest entries of the events log, at most LOG_LIMIT. */
  readonly log: ReadonlyArray<LogEntry>
  /** How many entries were ever logged, those dropped included. */
  readonly logged: number
}

export const emptyBoard = (session: string): Board => ({
  session, records: [], contexts: new Map(), prompts: new Map(), usage: new Map(), pieces: new Map(), log: [], logged: 0,
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
    onSome: (message) => clip(message.text),
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

const set = <V>(map: ReadonlyMap<number, V>, key: number, value: V): ReadonlyMap<number, V> => new Map(map).set(key, value)

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
      return withEntry({ ...board, contexts: set(board.contexts, trace.turn, { upTo: trace.upTo, messages: trace.messages }) }, {
        ...base, kind: "memory", turn: trace.turn, title: `memory gave ${trace.messages.length} message${trace.messages.length === 1 ? "" : "s"}`, detail: json(trace.messages),
      })
    case "Prompt":
      return withEntry({ ...board, prompts: set(board.prompts, trace.turn, trace.messages) }, {
        ...base, kind: "prompt", turn: trace.turn, title: `prompt sent: ${trace.messages.length} messages, ~${tokensOf(trace.messages)} tokens`, detail: json(trace.messages),
      })
    case "Usage":
      return withEntry({ ...board, usage: set(board.usage, trace.turn, trace.usage) }, {
        ...base, kind: "usage", turn: trace.turn, title: "the provider reported its usage", detail: json(trace.usage),
      })
    case "Piece": {
      const pieces = set(board.pieces, trace.turn, (board.pieces.get(trace.turn) ?? 0) + 1)
      // One log line per turn's stream, not one per piece.
      return (board.pieces.get(trace.turn) ?? 0) === 0
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

export const tokensOf = (messages: ReadonlyArray<Said>): number => messages.reduce((sum, message) => sum + estimateTokens(message.text), 0)

// ── one turn's view ─────────────────────────────────────────────────────────

export type StepState = "done" | "now" | "todo" | "failed" | "skipped"
export type StepId = "opened" | "stored-message" | "context" | "prompt" | "streamed" | "stored-answer" | "closed"

export interface StepView {
  readonly id: StepId
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

/** How a record stands for the turn shown. */
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

export interface TurnView {
  readonly turn: number
  readonly closed: Option.Option<string>
  readonly steps: ReadonlyArray<StepView>
  readonly journal: ReadonlyArray<JournalRow>
  readonly memory: Option.Option<ReadonlyArray<MemoryRow>>
  readonly prompt: Option.Option<ReadonlyArray<PromptRow>>
  readonly promptTokens: number
  readonly reusedTokens: number
  readonly usage: Option.Option<Reported>
}

/** The turns of the conversation, in order. */
export const turnsOf = (board: Board): ReadonlyArray<number> =>
  board.records.flatMap((record) => (record.name === turnStartedEvent.name ? [record.turn] : []))

const said = (record: StoredEvent): Option.Option<Said> =>
  Option.map(messageOf(record), (message) => ({ role: message._tag === "User" ? "user" : "assistant", text: message.text }))

const same = (a: Said, b: Said) => a.role === b.role && a.text === b.text

/** Which record each context message came from: matched from the newest back, so a repeated text finds its own record. */
const linkContext = (records: ReadonlyArray<StoredEvent>, messages: ReadonlyArray<Said>): ReadonlyArray<Option.Option<number>> => {
  const pool = records.flatMap((record) => Option.match(said(record), { onNone: () => [], onSome: (message) => [{ seq: record.seq, message }] }))
  const used = new Set<number>()
  const links: Array<Option.Option<number>> = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const found = pool.findLast((entry) => !used.has(entry.seq) && same(entry.message, message))
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

export const viewOf = (board: Board, turn: number): TurnView => {
  const ofTurn = (name: string) => Option.fromNullishOr(board.records.find((record) => record.turn === turn && record.name === name))
  const started = Option.fromNullishOr(board.records.find((record) => record.name === turnStartedEvent.name && record.turn === turn))
  const ended = ofTurn(turnEndedEvent.name)
  const userRecord = ofTurn(userMessageEvent.name)
  const answerRecord = ofTurn(assistantMessageEvent.name)
  const context = Option.fromNullishOr(board.contexts.get(turn))
  const promptSaid = Option.fromNullishOr(board.prompts.get(turn))
  const previousPrompt = Option.fromNullishOr(board.prompts.get(turn - 1))

  const memory = Option.map(context, ({ upTo, messages }) => {
    const links = linkContext(board.records.filter((record) => record.seq <= upTo), messages)
    return messages.map((message, index): MemoryRow => ({ ...message, tokens: estimateTokens(message.text), seq: links[index] ?? Option.none() }))
  })
  const inContext = new Set(Option.match(memory, { onNone: () => [], onSome: (rows) => rows.flatMap((row) => Option.toArray(row.seq)) }))
  const upTo = Option.match(context, { onNone: () => Infinity, onSome: (seen) => seen.upTo })

  const journal = board.records.map((record): JournalRow => {
    const role = Option.map(said(record), (message) => message.role)
    const use: RecordUse = Option.isNone(role) ? "not-conversation"
      : record.seq > upTo ? "later"
        : Option.isNone(context) || inContext.has(record.seq) ? "in-context" : "left-out"
    return {
      seq: record.seq, turn: record.turn, name: record.name, tags: record.tags, summary: summaryOf(record), role, use,
      ofTurn: record.turn === turn, payload: json(record.message === undefined ? record.data : { data: record.data, message: record.message }),
    }
  })

  const prompt = Option.map(promptSaid, (messages) => {
    const fromMemory = Option.getOrElse(memory, () => [] as ReadonlyArray<MemoryRow>)
    let next = 0
    let prefix = true
    return messages.map((message, index): PromptRow => {
      prefix = prefix && Option.match(previousPrompt, { onNone: () => false, onSome: (before) => before[index] !== undefined && same(before[index]!, message) })
      const tokens = estimateTokens(message.text)
      if (index === 0 && message.role === "system") return { ...message, tokens, source: "code", seq: Option.none(), reused: prefix }
      const memoryRow = fromMemory[next]
      if (memoryRow !== undefined && same(memoryRow, message)) {
        next++
        return { ...message, tokens, source: "memory", seq: memoryRow.seq, reused: prefix }
      }
      return { ...message, tokens, source: "added", seq: Option.none(), reused: prefix }
    })
  })
  const promptRows: ReadonlyArray<PromptRow> = Option.getOrElse(prompt, (): ReadonlyArray<PromptRow> => [])
  const promptTokens = promptRows.reduce((sum: number, row: PromptRow) => sum + row.tokens, 0)
  const reusedTokens = promptRows.reduce((sum: number, row: PromptRow) => sum + (row.reused ? row.tokens : 0), 0)

  const closed = Option.map(ended, outcomeOfRecord)
  const pieces = board.pieces.get(turn) ?? 0
  const seqOf = (found: Option.Option<StoredEvent>) => Option.match(found, { onNone: () => [], onSome: (one) => [one.seq] })
  const memoryCount = Option.match(memory, { onNone: () => 0, onSome: (rows) => rows.length })
  const leftOut = journal.filter((row) => row.use === "left-out").length
  const added = promptRows.filter((row) => row.source === "added").length

  const raw: ReadonlyArray<Omit<StepView, "state"> & { readonly happened: boolean }> = [
    {
      id: "opened", label: "Turn opened", code: "sessions.open(chat.session)", column: "journal", happened: Option.isSome(started), seqs: seqOf(started),
      detail: Option.match(started, { onNone: () => "Opening the turn.", onSome: (one) => `Record #${one.seq}, ${one.name}. The turn's scope is open; it closes when the scope ends.` }),
    },
    {
      id: "stored-message", label: "Message stored", code: "session.append(userMessage(message))", column: "journal", happened: Option.isSome(userRecord), seqs: seqOf(userRecord),
      detail: Option.match(userRecord, { onNone: () => "Your message goes into the journal first.", onSome: (one) => `Record #${one.seq}, tagged ${one.tags.join(", ")}. It is in the journal before the model sees anything.` }),
    },
    {
      id: "context", label: "Memory built the context", code: "memory.context(session)", column: "memory", happened: Option.isSome(context),
      seqs: [...inContext],
      detail: Option.isSome(context)
        ? `${memoryCount} message${memoryCount === 1 ? "" : "s"} from the journal${leftOut > 0 ? `; ${leftOut} left out by memory` : ", nothing left out"}.`
        : "Memory reads the journal and picks what the model sees.",
    },
    {
      id: "prompt", label: "Prompt sent", code: "model.streamText({ prompt })", column: "prompt", happened: Option.isSome(prompt), seqs: [...inContext],
      detail: Option.isSome(prompt)
        ? `The system text from your code, ${memoryCount} from memory${added > 0 ? `, ${added} added by your code` : ""}: about ${promptTokens} tokens, ${reusedTokens} the same as the prompt before.`
        : "The prompt is built fresh: the system text, then the context.",
    },
    {
      id: "streamed", label: "Answer streamed", code: "chat.stream(piece)", column: "prompt", happened: pieces > 0, seqs: [],
      detail: pieces > 0 ? `${pieces} piece${pieces === 1 ? "" : "s"} streamed to the chat as they arrived.` : "Each piece goes to the chat as it arrives.",
    },
    {
      id: "stored-answer", label: "Answer stored", code: "session.append(assistantMessage(answer))", column: "journal", happened: Option.isSome(answerRecord), seqs: seqOf(answerRecord),
      detail: Option.match(answerRecord, { onNone: () => "The answer goes into the journal, for the next turn's context.", onSome: (one) => `Record #${one.seq}. The next turn's memory can read it.` }),
    },
    {
      id: "closed", label: "Turn closed", code: "the scope ends", column: "journal", happened: Option.isSome(ended), seqs: seqOf(ended),
      detail: Option.match(ended, { onNone: () => "The turn closes when its scope ends: answered, failed or stopped.", onSome: (one) => `Record #${one.seq}: ${outcomeOfRecord(one)}.` }),
    },
  ]
  const isClosed = Option.isSome(ended)
  const failed = Option.match(closed, { onNone: () => false, onSome: (text) => !text.startsWith("Completed") })
  const firstMissing = raw.findIndex((step) => !step.happened)
  const steps = raw.map(({ happened, ...step }, index): StepView => ({
    ...step,
    state: step.id === "closed" && isClosed && failed ? "failed"
      : happened ? "done"
        : isClosed ? "skipped"
          : index === firstMissing ? "now" : "todo",
  }))

  return {
    turn, closed, steps, journal, memory, prompt, promptTokens, reusedTokens,
    usage: Option.fromNullishOr(board.usage.get(turn)),
  }
}
