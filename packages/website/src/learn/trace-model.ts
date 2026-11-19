// What the Context tab shows, worked out from what the page heard: the
// conversation's journal, what memory built for each model call, each
// prompt the model received, and what the program told the chat. Pure: the
// page feeds it traces (`record`), and asks for one turn's view (`viewOf`).
// A turn may call the model several times (a turn with tools is a loop over
// steps), so its steps are built from what happened, call by call.
import { Option, Predicate } from "effect"
import { dataOf, messageOf, SessionId, turnEndedEvent, TurnNumber, turnStartedEvent } from "@xandreed/core"
import type { Message, StoredEvent } from "@xandreed/core"
import {
  aliasedEvent, curatedEvent, curationFailedEvent, entityEvent, estimateTokens, FACTS_OWNER, forgottenEvent, KNOWLEDGE_OWNER, knowledgeOf, learnedEvent, memoryEndedEvent,
  memoryEvent, memoryRestatedEvent, resultText, sourceEvent, TASKS_OWNER, turnsOf,
} from "@xandreed/sdk"
import type { ClosedRead, TurnRead } from "@xandreed/sdk"
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

/**
 * What a session is, read from its header and never guessed from its place in a list: the chat's conversation; a
 * helper's (lesson 4: it has a parent); a background task's (lesson 17: the tasks plugin owns it, and it has a
 * parent); the memory session (lesson 11: the facts plugin owns it, and it continues no other); the knowledge
 * session (lesson 18: a curator's journal, owned by `KNOWLEDGE_OWNER`, which continues no other); or another session
 * of the program's own making.
 */
export type SessionKind = "chat" | "helper" | "task" | "memory" | "knowledge" | "other"

/** What the page heard of a session's header: who owns it, and the session it was created under, if any. */
export interface SessionSeen {
  readonly owner: string
  readonly parent: Option.Option<string>
}

/**
 * The kind of a session: the chat's is the one the page shows; any other is told by its header, as the kernel
 * tells the memory session (the facts plugin's own, with no parent) and the knowledge session (`KNOWLEDGE_OWNER`'s,
 * with no parent). One whose header was never heard is no helper and no memory: it is another session.
 */
export const kindOf = (session: string, chat: string, header: Option.Option<SessionSeen>): SessionKind =>
  session === chat ? "chat" : Option.match(header, {
    onNone: (): SessionKind => "other",
    onSome: ({ owner, parent }): SessionKind =>
      Option.isSome(parent) ? (owner === TASKS_OWNER ? "task" : "helper")
        : owner === FACTS_OWNER ? "memory" : owner === KNOWLEDGE_OWNER ? "knowledge" : "other",
  })

/**
 * One prompt of a turn as it was sent: to which model, while which model was picked, and how its stream ended when
 * it failed (`PromptFailed`). A prompt whose stream failed is an attempt of a model call that has no answer: the
 * call is tried again or handed to another model (lesson 14), or it ends the turn.
 */
export interface AttemptSeen {
  readonly model: string
  readonly picked: string
  readonly failed: Option.Option<string>
}

/**
 * Everything heard about one session. Per turn: one context per model call, and one prompt per attempt, in order.
 * A model call is tried once unless a plan tries it again (lesson 14): its prompts are then each attempt's, every
 * one but the last marked failed. The tools offered, whether the turn was given, the usage, the pieces streamed
 * and how it ended are each prompt's.
 */
export interface Board {
  readonly session: string
  readonly records: ReadonlyArray<StoredEvent>
  readonly contexts: ReadonlyMap<number, ReadonlyArray<ContextSeen>>
  readonly prompts: ReadonlyMap<number, ReadonlyArray<ReadonlyArray<Said>>>
  /** The tools offered with each prompt, by turn. */
  readonly offered: ReadonlyMap<number, ReadonlyArray<ReadonlyArray<string>>>
  /** Whether each prompt's stream ran with its turn given, by turn: the loop handed it to the kernel's `modelAnswer`. */
  readonly given: ReadonlyMap<number, ReadonlyArray<boolean>>
  /** What the provider reported each prompt cost, by turn: none for a stream that ended before it said. */
  readonly usage: ReadonlyMap<number, ReadonlyArray<Option.Option<Reported>>>
  /** Each prompt's model, and whether its stream failed, by turn. */
  readonly attempts: ReadonlyMap<number, ReadonlyArray<AttemptSeen>>
  /** What a summarizer was sent while memory compacted, by turn: model calls of their own, not the turn's. */
  readonly summaries: ReadonlyMap<number, ReadonlyArray<ReadonlyArray<Said>>>
  /**
   * The curator's model calls (lesson 18), by the turn of the knowledge session that stored their source: what each
   * was sent, and its reply or why it failed. They run in no turn: the source's turn is closed when they are made.
   */
  readonly curations: ReadonlyMap<number, ReadonlyArray<CuratorCallSeen>>
  /** Pieces streamed, by turn, per prompt. */
  readonly pieces: ReadonlyMap<number, ReadonlyArray<number>>
  /** The newest entries of the events log, at most LOG_LIMIT. */
  readonly log: ReadonlyArray<LogEntry>
  /** How many entries were ever logged, those dropped included. */
  readonly logged: number
  /**
   * What the session is. A helper's turn (lesson 4) is opened by its caller, and its words stay out of the chat; a
   * turn on the memory session (lesson 11) stores a fact's record and calls no model.
   */
  readonly kind: SessionKind
  /**
   * The place of the last record read from the journal as the conversation was shown (a durable lesson, after a
   * reload): a turn that started at or before it ran in a page that is gone, and nothing of it but its records is here.
   */
  readonly restored: number
  /**
   * How the records up to `restored` came to be read rather than heard (lesson 15): with the page as it loaded
   * (`page`), with a chat this page showed before and shows again after a switch (`again`), and for a branch, the
   * records it copied up to `through`, from the chat named `from` (`copied`). Turns past the copy read as the rest do.
   */
  readonly readBack: ReadBack
}

/** One call of the curator (lesson 18): the model it was sent to, what it was sent, and its reply or why it failed. */
export interface CuratorCallSeen {
  readonly model: string
  readonly messages: ReadonlyArray<Said>
  /** What the call was for, said with its reply: `extract` or `review`; none while it has not answered. */
  readonly job: Option.Option<"extract" | "review">
  readonly reply: Option.Option<string>
  readonly failed: Option.Option<string>
  /** The program stopped while it waited for this call's reply: Stop, a rebuild or Clear context cut it short. */
  readonly cut: boolean
}

/** How a board's restored records came to be read: see `Board.readBack`. */
export interface ReadBack {
  readonly how: "page" | "again"
  readonly copied: Option.Option<{ readonly through: number; readonly from: string }>
}

export const emptyBoard = (session: string, kind: SessionKind = "chat"): Board => ({
  session, records: [], contexts: new Map(), prompts: new Map(), offered: new Map(), given: new Map(), usage: new Map(), attempts: new Map(), summaries: new Map(), curations: new Map(), pieces: new Map(), log: [], logged: 0, kind, restored: 0,
  readBack: { how: "page", copied: Option.none() },
})

export const LOG_LIMIT = 400

const clip = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? ""

/**
 * The message a record has the model read: a record of the conversation's, or a memory's own record that carries the
 * text it sends (the summary memory's summary, ADR 0008).
 */
export const sentMessageOf = (record: Pick<StoredEvent, "name" | "data" | "tags" | "message">): Option.Option<Message> =>
  Option.orElse(messageOf(record), () => record.tags.some((tag) => tag === "memory") ? Option.fromNullishOr(record.message) : Option.none())

/** A record, in a few words. */
export const summaryOf = (record: Pick<StoredEvent, "name" | "data" | "tags" | "message">): string =>
  Option.match(sentMessageOf(record), {
    onSome: (message) => clip(saidOfStored(message).text),
    onNone: () => {
      const data = record.data
      // A fact's record (lesson 11), in the memory session: the fact and where it came from, or the fact that no longer stands.
      const learned = dataOf(learnedEvent, record)
      if (Option.isSome(learned)) return clip(`fact ${learned.value.id}, from turn ${learned.value.from.turn} of conversation ${learned.value.from.session.slice(0, 8)}: ${learned.value.text}`)
      const forgotten = dataOf(forgottenEvent, record)
      if (Option.isSome(forgotten)) return `fact ${forgotten.value.id} no longer stands`
      // The knowledge session's records (lesson 18): each with the source it came from.
      const source = dataOf(sourceEvent, record)
      if (Option.isSome(source)) return clip(`source ${source.value.id}: ${source.value.said.map((part) => `${part.by}: ${part.text}`).join(" ")}`)
      const entity = dataOf(entityEvent, record)
      if (Option.isSome(entity)) return clip(`entity ${entity.value.id}, ${entity.value.name} (${entity.value.kind}), from ${entity.value.source}`)
      const aliased = dataOf(aliasedEvent, record)
      if (Option.isSome(aliased)) return clip(`entity ${aliased.value.id} is also called ${aliased.value.alias}, from ${aliased.value.source}`)
      const memory = dataOf(memoryEvent, record)
      if (Option.isSome(memory)) return clip(`memory ${memory.value.id}, from ${memory.value.source}: ${memory.value.text}`)
      const again = dataOf(memoryRestatedEvent, record)
      if (Option.isSome(again)) return clip(`memory ${again.value.id} said again, in ${again.value.source}: "${again.value.quote}"`)
      const ended = dataOf(memoryEndedEvent, record)
      if (Option.isSome(ended)) return `memory ${ended.value.id} ended (${ended.value.why}${ended.value.by === undefined ? "" : `, replaced by ${ended.value.by}`}), in ${ended.value.source}`
      const curated = dataOf(curatedEvent, record)
      if (Option.isSome(curated)) return `${curated.value.source} curated: ${curated.value.calls} model call${curated.value.calls === 1 ? "" : "s"}, ${curated.value.kept} kept, ${curated.value.dropped.length} dropped`
      const failed = dataOf(curationFailedEvent, record)
      if (Option.isSome(failed)) return clip(`${failed.value.source}: try ${failed.value.attempt} failed: ${failed.value.reason}`)
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

/** The last entry of a turn's list changed, or the map as it was when the turn has none. */
const changeLast = <V>(map: ReadonlyMap<number, ReadonlyArray<V>>, key: number, to: (value: V) => V): ReadonlyMap<number, ReadonlyArray<V>> => {
  const values = map.get(key) ?? []
  const last = values.at(-1)
  return last === undefined ? map : new Map(map).set(key, [...values.slice(0, -1), to(last)])
}

export const tokensOf = (messages: ReadonlyArray<Said>): number => messages.reduce((sum, message) => sum + estimateTokens(message.text), 0)

/** The board after one more trace, heard `at` ms after it started. Events of another conversation are left out. */
export const record = (board: Board, trace: Trace, at: number): Board => {
  const base = { at, seq: Option.none<number>(), tags: [] as ReadonlyArray<string> }
  switch (trace._tag) {
    case "Event": {
      const event = trace.event
      if (event.session !== board.session) return board
      if (event._tag === "Stored") {
        // A record is taken once: one read from the journal as the conversation was shown, then heard announced, is passed over.
        if (event.seq <= (board.records.at(-1)?.seq ?? 0)) return board
        const { session: _session, _tag: _ignored, ...stored } = event
        return withEntry({ ...board, records: [...board.records, stored] }, {
          ...base, kind: "record", turn: event.turn, seq: Option.some(event.seq), tags: event.tags,
          title: `stored #${event.seq} ${event.name}`, detail: json(event.message === undefined ? event.data : { data: event.data, message: event.message }),
        })
      }
      return withEntry(board, { ...base, kind: "live", turn: event.turn ?? 0, tags: event.tags, title: `live ${event.name}`, detail: json(event.data) })
    }
    case "Context":
      // Another session's (a helper's): this board shows the chat's.
      if (trace.session !== board.session) return board
      return withEntry({ ...board, contexts: append(board.contexts, trace.turn, { upTo: trace.upTo, messages: trace.messages }) }, {
        ...base, kind: "memory", turn: trace.turn, title: `memory gave ${trace.messages.length} message${trace.messages.length === 1 ? "" : "s"}`, detail: json(trace.messages),
      })
    case "Prompt": {
      if (trace.session !== board.session) return board
      if (trace.purpose === "curation") {
        const call: CuratorCallSeen = { model: trace.model, messages: trace.messages, job: Option.none(), reply: Option.none(), failed: Option.none(), cut: false }
        return withEntry({ ...board, curations: append(board.curations, trace.turn, call) }, {
          ...base, kind: "prompt", turn: trace.turn,
          title: `curator prompt sent to ${trace.model}: ~${tokensOf(trace.messages)} tokens (a model call of the curator's, in no turn)`,
          detail: json(trace.messages),
        })
      }
      if (trace.purpose === "summary") {
        return withEntry({ ...board, summaries: append(board.summaries, trace.turn, trace.messages) }, {
          ...base, kind: "prompt", turn: trace.turn,
          title: `summarizer prompt sent: ${trace.messages.length} messages, ~${tokensOf(trace.messages)} tokens (a model call of memory's, not the turn's)`,
          detail: json(trace.messages),
        })
      }
      const pieces = append(board.pieces, trace.turn, 0)
      const attempts = append(board.attempts, trace.turn, { model: trace.model, picked: trace.picked, failed: Option.none<string>() })
      return withEntry({
        ...board, prompts: append(board.prompts, trace.turn, trace.messages), offered: append(board.offered, trace.turn, trace.tools), given: append(board.given, trace.turn, trace.givenTurn === true),
        usage: append(board.usage, trace.turn, Option.none<Reported>()), attempts, pieces,
      }, {
        ...base, kind: "prompt", turn: trace.turn,
        title: `prompt sent${trace.model === trace.picked ? "" : ` to ${trace.model}`}: ${trace.messages.length} messages, ~${tokensOf(trace.messages)} tokens${trace.tools.length > 0 ? `, ${trace.tools.length} tools offered` : ""}`,
        detail: json(trace.tools.length > 0 ? { messages: trace.messages, tools: trace.tools } : trace.messages),
      })
    }
    case "PromptFailed":
      // The turn's last prompt is an attempt with no answer: its stream failed. A summarizer's is no try of the turn's call.
      if (trace.session !== board.session) return board
      if (trace.purpose === "summary") return withEntry(board, { ...base, kind: "prompt", turn: trace.turn, title: "the summarizer's stream failed", detail: trace.reason })
      if (trace.purpose === "curation") {
        return withEntry({ ...board, curations: changeLast(board.curations, trace.turn, (call) => ({ ...call, failed: Option.some(trace.reason) })) }, {
          ...base, kind: "prompt", turn: trace.turn, title: "the curator's stream failed", detail: trace.reason,
        })
      }
      return withEntry({ ...board, attempts: changeLast(board.attempts, trace.turn, (attempt) => ({ ...attempt, failed: Option.some(trace.reason) })) }, {
        ...base, kind: "prompt", turn: trace.turn, title: "the prompt's stream failed: that attempt has no answer", detail: trace.reason,
      })
    case "Usage":
      // Another session's (a helper's): this board shows the chat's.
      if (trace.session !== board.session) return board
      if (trace.purpose === "summary") return withEntry(board, { ...base, kind: "usage", turn: trace.turn, title: "the provider reported the summarizer's usage", detail: json(trace.usage) })
      if (trace.purpose === "curation") return withEntry(board, { ...base, kind: "usage", turn: trace.turn, title: "the provider reported the curator's usage", detail: json(trace.usage) })
      // The usage of the turn's last prompt: its stream reports it as it ends.
      return withEntry({ ...board, usage: changeLast(board.usage, trace.turn, () => Option.some(trace.usage)) }, {
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
    case "Taken":
      return board
    case "Reported":
      // Lesson 17: a task's report waits in the chat's queue, for a turn of its own.
      return withEntry(board, { ...base, kind: "chat", turn: board.records.at(-1)?.turn ?? 0, title: `task ${trace.task}'s report waits in the chat's queue`, detail: trace.session })
    case "Embedded":
      // Lesson 20: the page's embedder made vectors, inside the context being built for the turn open.
      return withEntry(board, { ...base, kind: "memory", turn: board.records.at(-1)?.turn ?? 0, title: `the embedder made ${trace.count} vector${trace.count === 1 ? "" : "s"}, of ${trace.as === "query" ? "a message" : "memories"}`, detail: json(trace) })
    case "ReportsDropped":
      return withEntry(board, { ...base, kind: "program", turn: board.records.at(-1)?.turn ?? 0, title: `${trace.sessions.length === 1 ? "a report" : `${trace.sessions.length} reports`} dropped as the program stopped`, detail: json(trace.sessions) })
    case "Asking":
      // A tool asked before it acts: the question is the page's to put, in the turn the conversation has open.
      return withEntry(board, { ...base, kind: "chat", turn: board.records.at(-1)?.turn ?? 0, title: `approval asked: ${trace.action}`, detail: trace.detail })
    case "Asked":
      return board
    case "Session":
      // A session's header: what the row of sessions is built from (`heardBy`), and nothing of a board's own.
      return board
    case "CurationCut":
      // Lesson 18: the program stopped while the curator worked: a call still waiting for its reply was cut short.
      if (trace.session !== board.session) return board
      return withEntry({ ...board, curations: changeLast(board.curations, trace.turn, (call) => (Option.isNone(call.reply) && Option.isNone(call.failed) ? { ...call, cut: true } : call)) }, {
        ...base, kind: "program", turn: trace.turn, title: `the curation of ${trace.source} was cut short as the program stopped`, detail: trace.source,
      })
    case "CuratorAnswered":
      // Lesson 18: the curator's reply, for the call it answered: the last one filed under its source's turn.
      if (trace.session !== board.session) return board
      return withEntry({ ...board, curations: changeLast(board.curations, trace.turn, (call) => ({ ...call, job: Option.some(trace.job), reply: Option.some(trace.reply) })) }, {
        ...base, kind: "prompt", turn: trace.turn, title: `the curator answered (${trace.job}, try ${trace.attempt} of ${trace.source})`, detail: trace.reply,
      })
    case "Showing":
      // The conversation as its store holds it, read when the program named it: each record is taken as one announced is.
      if (trace.session !== board.session) return board
      return {
        ...trace.journal.reduce((seeded, event) => record(seeded, { _tag: "Event", event: { _tag: "Stored", session: SessionId.make(trace.session), ...event } }, at), board),
        // Only what this page did not hear of live: a rebuild shows the same conversation again, and its turns ran here.
        restored: Math.max(board.restored, board.records.length === 0 ? (trace.journal.at(-1)?.seq ?? 0) : board.restored),
        // Lesson 15: a chat shown again after a switch, and a branch's copied records, say so; a reload reads as before.
        readBack: board.records.length === 0
          ? { how: trace.again === true ? "again" : "page", copied: Option.map(Option.fromNullishOr(trace.branch), ({ through, label }) => ({ through, from: label })) }
          : board.readBack,
      }
  }
}

// ── one turn's view ─────────────────────────────────────────────────────────

export type StepState = "done" | "now" | "todo" | "failed" | "skipped"
export type StepKind = "opened" | "stored-message" | "steered" | "compacted" | "context" | "attempt" | "prompt" | "streamed" | "stored-answer" | "tools" | "stored-record" | "closed"

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
export type RecordUse = "in-context" | "left-out" | "later" | "not-conversation" | "fact" | "kept"

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
  /** A tool's result sent as a pointer (ADR 0011): how many tokens of it the journal keeps, by the stored result's estimate. */
  readonly pointer: Option.Option<number>
}

/**
 * How much of a stored tool result the journal keeps when the model was sent something else for it (a pointer, ADR
 * 0011): the stored result's estimate, in tokens. None when the record holds no tool result, when the message
 * answers another call, or when what was sent is the result as stored. It compares what was sent with what is
 * stored, and never looks for a pointer's words.
 */
export const keptInJournal = (sent: Said, record: Pick<StoredEvent, "name" | "data" | "tags" | "message">): Option.Option<number> =>
  Option.flatMap(messageOf(record), (message) =>
    message._tag === "ToolResult" && sent.resultId === message.id && sent.text !== saidOfStored(message).text
      ? Option.some(Number(estimateTokens(resultText(message.result))))
      : Option.none())

/** One attempt of a model call, as its prompt's stream ended. */
export interface AttemptView {
  /** Its count in the call, from 1. */
  readonly attempt: number
  /** The model it was sent to. */
  readonly model: string
  /** Why its stream failed, in the failure's words; none when it did not. */
  readonly failed: Option.Option<string>
  /** How many pieces of it reached the chat. */
  readonly pieces: number
}

/** One model call of a turn: what memory gave it, and the prompt it received. */
export interface CallView {
  readonly call: number
  readonly memory: Option.Option<ReadonlyArray<MemoryRow>>
  /** The prompt of the call's last attempt. */
  readonly prompt: Option.Option<ReadonlyArray<PromptRow>>
  readonly promptTokens: number
  readonly reusedTokens: number
  readonly usage: Option.Option<Reported>
  /** The tools offered with the prompt: code, never stored. */
  readonly tools: ReadonlyArray<string>
  /** The journal as this call saw it. */
  readonly journal: ReadonlyArray<JournalRow>
  /** Each prompt sent for this call, in order (lesson 14: a call under a plan may be tried again): one for a call tried once. */
  readonly attempts: ReadonlyArray<AttemptView>
  /**
   * The model the answer's record names, when it is worth saying: the turn's answers name more than one model, or
   * a model other than the one picked when the turn ran (lesson 14's spare). None for a call the picked model
   * answered, as in every turn of lessons 1 to 13.
   */
  readonly answeredBy: Option.Option<string>
}

/**
 * The prompts of a turn grouped by model call, as the places of the prompts in the turn's list. An attempt whose
 * stream failed belongs to the call of the prompt after it: the call was tried again. The prompts after the last
 * one that did not fail are one call more, which has no answer. The pairing is read from the prompts alone, never
 * from the records' order, which the page hears on a fiber of its own. With no prompt marked failed, call `n` is
 * prompt `n`.
 */
export const attemptsByCall = (board: Board, turn: number): ReadonlyArray<ReadonlyArray<number>> => {
  const groups: Array<ReadonlyArray<number>> = []
  let current: Array<number> = []
  for (const [index, attempt] of (board.attempts.get(turn) ?? []).entries()) {
    current.push(index)
    if (Option.isNone(attempt.failed)) {
      groups.push(current)
      current = []
    }
  }
  return current.length > 0 ? [...groups, current] : groups
}

/** The model a stored answer names (`model` on its record), when it names one. */
const modelOfRecord = (record: Pick<StoredEvent, "data"> | undefined): Option.Option<string> =>
  Predicate.hasProperty(record?.data, "model") && Predicate.isString(record.data.model) ? Option.some(record.data.model) : Option.none()

export interface TurnView {
  readonly turn: number
  /** The turn ran before this page loaded: its records were read from the journal, and its contexts and prompts were never stored. */
  readonly restored: boolean
  /** What a restored turn's steps say of it: why only its records are here (`restoredWords`). */
  readonly readBack: RestoredWords
  readonly closed: Option.Option<string>
  readonly steps: ReadonlyArray<StepView>
  readonly calls: ReadonlyArray<CallView>
}

/** What a restored turn's context and prompt steps say. */
export const BEFORE_THIS_PAGE = "This turn ran before the page was loaded. Its contexts and prompts were built for one call each and never stored: what is left is what it stored."

/** What a restored turn says: the heads of its memory and prompt columns, its steps' detail, and the code its stored steps name. */
export interface RestoredWords {
  readonly head: string
  readonly detail: string
  readonly code: string
}

/**
 * Why a turn read back from the journal has only its records (lesson 15 adds two reasons to lesson 7's): it ran
 * before the page loaded; it ran before the chat was shown again after a switch, which dropped what the page saw of
 * it; or a branch copied it from the chat it was cut from.
 */
export const restoredWords = (readBack: ReadBack, started: number): RestoredWords =>
  Option.match(Option.filter(readBack.copied, ({ through }) => started <= through), {
    onSome: ({ from }) => ({
      head: `copied from ${from}`,
      detail: `This turn was copied from ${from} when the branch was made, record for record. Its contexts and prompts were built for one call each and never stored: what is left is what it stored.`,
      code: `copied from ${from}`,
    }),
    onNone: () => readBack.how === "again"
      ? {
        head: "before this chat was shown again",
        detail: "This turn ran before you switched back to this chat. Its contexts and prompts were built for one call each and never stored: what is left is what it stored.",
        code: "stored before this chat was shown again",
      }
      : { head: "before this page loaded", detail: BEFORE_THIS_PAGE, code: "stored before this page loaded" },
  })

/** The numbers of the conversation's turns, in order: one for each turn a record opened. */
export const turnNumbersOf = (board: Board): ReadonlyArray<number> =>
  board.records.flatMap((record) => (record.name === turnStartedEvent.name ? [record.turn] : []))

/** Which record each context message came from: matched from the newest back, so a repeated text finds its own record. */
const linkContext = (records: ReadonlyArray<StoredEvent>, messages: ReadonlyArray<Said>): ReadonlyArray<Option.Option<number>> => {
  const pool = records.flatMap((record) => Option.match(sentMessageOf(record), { onNone: () => [], onSome: (message) => [{ seq: record.seq, said: saidOfStored(message) }] }))
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

/** How a turn closed, in words: its outcome, and why when it failed. */
const outcomeText = ({ outcome }: ClosedRead): string => ("reason" in outcome ? `${outcome._tag}: ${outcome.reason}` : outcome._tag)

/**
 * One turn of a board as the kernel reads it from the records (`turnsOf`): its start, its messages, a step for
 * each answer with its calls and their results, and how it closed. A turn no record names yet has none of them.
 */
const readOf = (board: Board, turn: number): TurnRead =>
  turnsOf(board.records).find((one) => one.turn === turn)
    ?? { turn: TurnNumber.make(turn), opened: Option.none(), messages: [], steps: [], answer: Option.none(), closed: Option.none(), records: [] }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The journal as one model call saw it: what memory took, what it left out, what came later. */
const journalFor = (board: Board, turn: number, context: Option.Option<ContextSeen>, inContext: ReadonlySet<number>): ReadonlyArray<JournalRow> => {
  const upTo = Option.match(context, { onNone: () => Infinity, onSome: (seen) => seen.upTo })
  return board.records.map((record): JournalRow => {
    const role = Option.map(sentMessageOf(record), (message) => saidOfStored(message).role)
    // In the memory session a fact's record is what the session is for: no memory builds a context from its journal.
    const ofFact = board.kind === "memory" && (Option.isSome(dataOf(learnedEvent, record)) || Option.isSome(dataOf(forgottenEvent, record)))
    // In the knowledge session (lesson 18) every record but a turn's start and end is what the session keeps.
    const ofKnowledge = board.kind === "knowledge" && record.name !== turnStartedEvent.name && record.name !== turnEndedEvent.name
    const use: RecordUse = ofFact ? "fact"
      : ofKnowledge ? "kept"
      : Option.isNone(role) ? "not-conversation"
      : record.seq > upTo ? "later"
        : Option.isNone(context) || inContext.has(record.seq) ? "in-context" : "left-out"
    return {
      seq: record.seq, turn: record.turn, name: record.name, tags: record.tags, summary: summaryOf(record), role, use,
      ofTurn: record.turn === turn, payload: json(record.message === undefined ? record.data : { data: record.data, message: record.message }),
    }
  })
}

/**
 * One model call of a turn: its context, and the prompt of its last attempt, at the place `sent` gives in the
 * turn's prompts; `tried` are the places of every attempt's prompt, that one included.
 */
const callViewOf = (board: Board, turn: number, index: number, tried: ReadonlyArray<number>, previous: Option.Option<ReadonlyArray<Said>>, answeredBy: Option.Option<string>): CallView => {
  const context = Option.fromNullishOr(board.contexts.get(turn)?.[index])
  const sent = tried.at(-1) ?? -1
  const promptSaid = Option.fromNullishOr(board.prompts.get(turn)?.[sent])
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
      // The same message as the prompt before had here, and sent the same way: a tool's result matches its record by
      // its call, whatever was sent for it, so its text is compared too (a memory may send one record two ways).
      prefix = prefix && Option.match(previous, { onNone: () => false, onSome: (before) => before[at] !== undefined && before[at]!.key === message.key && before[at]!.text === message.text })
      const tokens = estimateTokens(message.text)
      const shown = { role: message.role, text: message.text, tokens, reused: prefix, pointer: Option.none<number>() }
      if (at === 0 && message.role === "system") return { ...shown, source: "code", seq: Option.none() }
      const row = fromMemory[next]
      if (row !== undefined && row.key === message.key) {
        next++
        // A tool's result that was sent as something other than what its record holds: a pointer.
        const stored = Option.flatMap(row.seq, (seq) => Option.fromNullishOr(board.records.find((one) => one.seq === seq)))
        return { ...shown, source: "memory", seq: row.seq, pointer: Option.flatMap(stored, (one) => keptInJournal(message, one)) }
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
    usage: Option.flatten(Option.fromNullishOr(board.usage.get(turn)?.[sent])),
    tools: board.offered.get(turn)?.[sent] ?? [],
    journal: journalFor(board, turn, context, inContext),
    attempts: tried.flatMap((at, place) => Option.toArray(Option.map(Option.fromNullishOr(board.attempts.get(turn)?.[at]), (seen): AttemptView => ({
      attempt: place + 1, model: seen.model, failed: seen.failed, pieces: board.pieces.get(turn)?.[at] ?? 0,
    })))),
    answeredBy,
  }
}

/** What a turn of the memory session (lesson 11) or the knowledge session (lesson 18) says of itself, by the session's kind. */
const KEPT_WORDS = {
  memory: {
    code: "sessions.turn(yield* memorySession, …)", opened: "A call of rememberFact or forgetFact is one turn on the memory session, opened while the conversation's own turn is open.",
    batch: "This turn stored many records at once, with no tool call.",
  },
  knowledge: {
    code: "sessions.turn(knowledge, …), in curate", opened: "The curation step (curate, called by curator.ts's keep after the chat's turn is answered) opens a turn on the knowledge session to store the source, and another to store what the checks kept. The curator's model calls run between the two, in no turn.",
    batch: "This turn stored many records at once: what the checks kept of the curator's reply, then the record that the source was curated; or, with no model, the page's Load the world, a source for each day the world says something and what a curator that made no mistake would keep.",
  },
} as const

/** A record of the memory session or the knowledge session, named for what it says. */
const keptLabel = (record: StoredEvent): string =>
  Option.isSome(dataOf(learnedEvent, record)) ? "Fact learned"
    : Option.isSome(dataOf(forgottenEvent, record)) ? "Fact forgotten"
      : Option.isSome(dataOf(sourceEvent, record)) ? "Source stored"
        : Option.isSome(dataOf(entityEvent, record)) ? "Entity stored"
          : Option.isSome(dataOf(aliasedEvent, record)) ? "Name added"
            : Option.isSome(dataOf(memoryEvent, record)) ? "Memory stored"
              : Option.isSome(dataOf(memoryRestatedEvent, record)) ? "Memory said again"
                : Option.isSome(dataOf(memoryEndedEvent, record)) ? "Memory ended"
                  : Option.isSome(dataOf(curatedEvent, record)) ? "Curated"
                    : Option.isSome(dataOf(curationFailedEvent, record)) ? "Curation failed"
                      : "Record stored"

/** The labels of the knowledge session's records (lesson 18). */
const KNOWLEDGE_LABELS: ReadonlyArray<string> = ["Source stored", "Entity stored", "Name added", "Memory stored", "Memory said again", "Memory ended", "Curated", "Curation failed"]

/** What the checks dropped of a curator's reply, from the records that say a source was curated (lesson 18). */
const droppedIn = (stored: ReadonlyArray<StoredEvent>): ReadonlyArray<{ readonly what: string; readonly why: string }> =>
  stored.flatMap((one) => Option.match(dataOf(curatedEvent, one), { onNone: () => [], onSome: (curated) => curated.dropped }))

/** The dropped items in words, for a step's detail: each with why. */
const droppedWords = (dropped: ReadonlyArray<{ readonly what: string; readonly why: string }>): string =>
  dropped.length === 0 ? "" : ` The checks dropped ${dropped.map((one) => `${one.what}: ${one.why}`).join("; ")}`

/**
 * The one step of a turn that stored many records at once: how many of each kind, by what each says ("Kept: 557
 * memories, 97 said again"), and the places of the first and the last.
 */
const batchStep = (stored: ReadonlyArray<StoredEvent>): StepView => {
  const counts = new Map<string, number>()
  for (const one of stored) counts.set(keptLabel(one), (counts.get(keptLabel(one)) ?? 0) + 1)
  const said = (label: string, one: string, many: string) => {
    const n = counts.get(label) ?? 0
    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`]
  }
  const parts = [
    ...said("Fact learned", "fact", "facts"), ...said("Fact forgotten", "forgotten", "forgotten"),
    ...said("Memory stored", "memory", "memories"), ...said("Memory said again", "said again", "said again"), ...said("Memory ended", "ended", "ended"),
    ...said("Entity stored", "entity", "entities"), ...said("Name added", "other name", "other names"), ...said("Source stored", "source", "sources"),
    ...said("Curated", "curated", "curated"), ...said("Curation failed", "failed try", "failed tries"), ...said("Record stored", "other record", "other records"),
  ]
  const dropped = droppedIn(stored)
  if (dropped.length > 0) parts.push(`${dropped.length} dropped`)
  const heading = counts.has("Fact learned") || counts.has("Fact forgotten") ? "Facts stored"
    : [...counts.keys()].some((label) => KNOWLEDGE_LABELS.includes(label)) ? "Kept" : "Records stored"
  const first = stored[0]!
  const last = stored.at(-1)!
  return {
    id: "stored-records", kind: "stored-record", call: 0, column: "journal", state: "done", seqs: stored.map((one) => one.seq), code: "session.append(…), once for each",
    label: `${heading}: ${parts.join(", ")}`,
    detail: `Records #${first.seq} to #${last.seq}: ${plural(stored.length, "record")} stored in this one turn. Open any of them in the Journal column. The first, in short: ${summaryOf(first)}${droppedWords(dropped)}`,
  }
}

/**
 * One turn of the memory session (lesson 11) or the knowledge session (lesson 18): one of the memory session was
 * opened by a call of a tool that writes there (`rememberFact`, `forgetFact`), stored one record, and closed.
 * No memory built a context and no model was called, so it has no such steps.
 */
const memoryTurnOf = (board: Board, turn: number, words: (typeof KEPT_WORDS)[keyof typeof KEPT_WORDS]): TurnView => {
  const { opened: started, closed: ended, records: ofTurn } = readOf(board, turn)
  const closed = Option.map(ended, outcomeText)
  const failed = Option.match(closed, { onNone: () => false, onSome: (text) => !text.startsWith("Completed") })
  const stored = ofTurn.filter((record) => record.name !== turnStartedEvent.name && record.name !== turnEndedEvent.name)
  const steps: ReadonlyArray<StepView> = [
    {
      id: "opened", kind: "opened", call: 0, label: "Turn opened", code: words.code, column: "journal",
      state: Option.isSome(started) ? "done" : "now", seqs: Option.toArray(started),
      detail: Option.match(started, {
        onNone: () => "Opening the turn.",
        onSome: (seq) => `Record #${seq}, ${turnStartedEvent.name}. ${stored.length > 1 ? words.batch : words.opened}`,
      }),
    },
    // A turn that stored many records at once (lesson 18's Load the world: 654 in one turn) is one step that counts
    // them, so the track stays readable; a tool's turn, which stores one, is a step for its record.
    ...(stored.length > 1 ? [batchStep(stored)] : stored.map((one, index): StepView => ({
      id: `stored-record-${index + 1}`, kind: "stored-record", call: 0, column: "journal", state: "done", seqs: [one.seq], code: "session.append(…)",
      label: droppedIn([one]).length === 0 ? keptLabel(one) : `${keptLabel(one)}: ${droppedIn([one]).length} dropped`,
      detail: `Record #${one.seq}, ${one.name}. Open it in the Journal column to read all of it. In short: ${summaryOf(one)}${droppedWords(droppedIn([one]))}`,
    }))),
    {
      id: "closed", kind: "closed", call: 0, label: "Turn closed", code: "the scope ends", column: "journal",
      state: Option.isNone(ended) ? (stored.length > 0 ? "now" : "todo") : failed ? "failed" : "done", seqs: Option.match(ended, { onNone: () => [], onSome: (one) => [one.seq] }),
      detail: Option.match(ended, { onNone: () => "The turn closes when its scope ends: the record is stored, or the call failed.", onSome: (one) => `Record #${one.seq}: ${outcomeText(one)}.` }),
    },
  ]
  const journal = journalFor(board, turn, Option.none(), new Set())
  const quiet: CallView = { call: 1, memory: Option.none(), prompt: Option.none(), promptTokens: 0, reusedTokens: 0, usage: Option.none(), tools: [], journal, attempts: [], answeredBy: Option.none() }
  if (board.kind !== "knowledge") return { turn, restored: false, readBack: restoredWords(board.readBack, 0), closed, steps, calls: [quiet] }
  const curations = board.curations.get(turn) ?? []
  const calls = curations.map((call, index): CallView => {
    const rows = call.messages.map((message): PromptRow => ({ role: message.role, text: message.text, tokens: estimateTokens(message.text), source: "added", seq: Option.none(), reused: false, pointer: Option.none() }))
    return { ...quiet, call: index + 1, prompt: Option.some(rows), promptTokens: rows.reduce((sum, row) => sum + row.tokens, 0) }
  })
  return { turn, restored: false, readBack: restoredWords(board.readBack, 0), closed, steps: [...steps, ...curatorSteps(board, stored, curations)], calls: calls.length > 0 ? calls : [quiet] }
}

/**
 * The steps of the curator's calls for the source a knowledge session's turn stored (lesson 18), after the turn's
 * own: each call's prompt and its reply, made in no turn; then, while no curation has kept the source, that it waits,
 * or that its tries failed, for the program's next turn to take up.
 */
const curatorSteps = (board: Board, stored: ReadonlyArray<StoredEvent>, curations: ReadonlyArray<CuratorCallSeen>): ReadonlyArray<StepView> => {
  const source = stored.flatMap((record) => Option.toArray(dataOf(sourceEvent, record)))[0]
  if (source === undefined) return []
  const calls = curations.flatMap((call, index): ReadonlyArray<StepView> => {
    const what = Option.match(call.job, { onNone: () => "", onSome: (job) => ` (${job})` })
    const asked: StepView = {
      id: `curator-asked-${index + 1}`, kind: "prompt", call: index + 1, column: "prompt", state: "done", seqs: [], code: "curator.curate({ prompt, job })",
      label: `Curator asked${what}`,
      detail: `The kernel's ${Option.contains(call.job, "review") ? "review prompt: the first prompt and the curator's reply, to check against the turn" : "curation prompt: the turn, what is stored about what it names, and the rules"}, sent to ${call.model} as one message, ~${tokensOf(call.messages)} tokens. It runs in no turn: the source's turn above is closed, and nothing of it is stored.`,
    }
    const answered: StepView = {
      id: `curator-answered-${index + 1}`, kind: "streamed", call: index + 1, column: "prompt", seqs: [], code: "the curator's reply",
      state: Option.isSome(call.failed) ? "failed" : Option.isSome(call.reply) ? "done" : call.cut ? "skipped" : "now",
      label: Option.isSome(call.failed) ? "Curator failed" : Option.isSome(call.reply) ? "Curator answered" : call.cut ? "Curator cut short" : "Curator answering",
      detail: Option.match(call.failed, {
        onSome: (reason) => `The call failed: ${reason}`,
        onNone: () => Option.match(call.reply, {
          onNone: () => call.cut ? "The program stopped (Stop, Rebuild or Clear context) before the curator answered: nothing of this curation was stored." : "Waiting for the curator's reply.",
          onSome: (reply) => `Its reply, which the kernel reads and checks before anything is stored: ${clip(reply, 600)}`,
        }),
      }),
    }
    return [asked, answered]
  })
  const state = knowledgeOf(board.records).sources.find((one) => one.source.id === source.id)?.state
  const waits: ReadonlyArray<StepView> = state === undefined || state._tag === "Curated" || (state._tag === "Pending" && curations.some((call) => Option.isNone(call.reply) && Option.isNone(call.failed) && !call.cut)) ? [] : [{
    id: "not-curated", kind: "stored-record", call: 0, column: "journal", seqs: [], code: "curateAgain(knowledge, source, options)",
    state: state._tag === "Failed" ? "failed" : "todo",
    label: state._tag === "Failed" ? `Not curated: ${state.attempts === 1 ? "its try" : `${state.attempts} tries`} failed` : "Not curated yet",
    detail: state._tag === "Failed"
      ? `${source.id} was not kept: ${state.reason} The program's next turn tries it again (curateAgain in curator.ts), up to three tries.`
      : `No curation has kept ${source.id} yet: Stop, Rebuild or Clear context cut its curation short, or it is under way. The program's next turn takes it up (curateAgain in curator.ts): nothing else does.`,
  }]
  return [...calls, ...waits]
}

/**
 * Whether a trace changes what the Context tab draws, given the board before it (none when its session is new). A piece
 * streamed after its call's first changes only a count of pieces: the chat draws the words, and the count is drawn once
 * the answer is stored. So the tab paints on a call's first piece and not on the later ones, and the work of a turn
 * does not grow with the answer's length. A second call's first piece paints, as the first call's did.
 */
export const paintsOn = (before: Option.Option<Board>, trace: Trace): boolean =>
  trace._tag !== "Piece" || Option.match(before, { onNone: () => true, onSome: (board) => (board.pieces.get(trace.turn)?.at(-1) ?? 0) === 0 })

/**
 * The conversation's records a turn stored after the context of `call` was built, once the turn has closed and only
 * for its last call, of that turn's own records: the answer, not a later turn's. The Memory column lists them
 * under that context, so what the turn added shows as it ends. They are not part of that context: memory builds the
 * next request's from the journal again. A turn read back from the journal has no context of its own, so none.
 */
export const storedAfter = (view: TurnView, call: CallView): ReadonlyArray<JournalRow> =>
  Option.isSome(view.closed) && !view.restored && call.call === view.calls.length
    ? call.journal.filter((row) => row.ofTurn && row.use === "later" && row.tags.includes("conversation"))
    : []

export const viewOf = (board: Board, turn: number): TurnView => {
  if (board.kind === "memory" || board.kind === "knowledge") return memoryTurnOf(board, turn, KEPT_WORDS[board.kind])
  // A session that is not the chat's (a helper's, or another of the program's own): its words stay out of the chat.
  const quiet = board.kind !== "chat"
  // The turn as the kernel reads it from the records: its start, its messages, its steps and how it closed.
  const { opened: started, messages: users, steps: answers, closed: ended, records: ofTurn } = readOf(board, turn)
  // A turn that started before the journal was read as the page loaded ran in a page that is gone.
  const restored = Option.exists(started, (seq) => seq <= board.restored)
  const readBack = restoredWords(board.readBack, Option.getOrElse(started, () => 0))
  // A memory's own records that carry what it sends: the summaries it stored as it compacted (ADR 0008).
  const compactions = ofTurn.filter((record) => Option.isNone(messageOf(record)) && Option.isSome(sentMessageOf(record)))
  const summarized = board.summaries.get(turn)?.length ?? 0
  // Each model call's attempts, by the places of their prompts: one each, unless a plan tried a call again.
  const tried = attemptsByCall(board, turn)
  const callCount = Math.max(tried.length, board.contexts.get(turn)?.length ?? 0, answers.length)
  // The place of each call's last prompt: the one its answer came from, if it has one.
  const sentAt = (index: number) => tried[index]?.at(-1) ?? -1

  // The model each answer's record names, and the model picked when the turn ran (none for a turn this page did not
  // see run). A name is said where the turn's answers name more than one model, or one other than the model picked.
  const named = answers.map((one) => modelOfRecord(board.records.find((record) => record.seq === one.seq)))
  const names = new Set(named.flatMap(Option.toArray))
  const picked = Option.fromNullishOr(board.attempts.get(turn)?.[0]?.picked)
  const answeredBy = (index: number) => Option.filter(Option.flatten(Option.fromNullishOr(named[index])), (name) => names.size > 1 || Option.exists(picked, (one) => one !== name))

  // The prompt before each call: the turn's previous call's, or the previous turn's last.
  const lastOf = (t: number) => Option.fromNullishOr(board.prompts.get(t)?.at(-1))
  const calls: Array<CallView> = []
  for (let index = 0; index < Math.max(1, callCount); index++) {
    const previous = index === 0 ? lastOf(turn - 1) : Option.fromNullishOr(board.prompts.get(turn)?.[sentAt(index - 1)])
    calls.push(callViewOf(board, turn, index, tried[index] ?? [], previous, answeredBy(index)))
  }

  const seqOf = (found: Option.Option<{ readonly seq: number }>) => Option.match(found, { onNone: () => [], onSome: (one) => [one.seq] })
  type Raw = Omit<StepView, "state"> & { readonly happened: boolean }
  const raw: Array<Raw> = []
  const first = Option.fromNullishOr(users[0])
  raw.push({
    id: "opened", kind: "opened", call: 0, label: "Turn opened", code: quiet ? "sessions.open(session)" : "sessions.open(chat.session)", column: "journal", happened: Option.isSome(started), seqs: Option.toArray(started),
    detail: Option.match(started, { onNone: () => "Opening the turn.", onSome: (seq) => `Record #${seq}, ${turnStartedEvent.name}. The turn's scope is open; it closes when the scope ends.` }),
  })
  // The messages the turn took as it opened: its own, and every one waiting behind it.
  const opening = users.filter((record) => record.seq < Option.match(Option.fromNullishOr(answers[0]), { onNone: () => Infinity, onSome: (one) => one.seq }))
  raw.push({
    id: "stored-message", kind: "stored-message", call: 0, label: opening.length > 1 ? `${opening.length} messages stored` : "Message stored", code: "session.append(userMessage(text))", column: "journal",
    happened: Option.isSome(first), seqs: opening.map((record) => record.seq),
    detail: Option.match(first, {
      onNone: () => "Your message goes into the journal first.",
      onSome: (one) => opening.length > 1
        ? `Records ${opening.map((record) => `#${record.seq}`).join(", ")}: your message, and the ${opening.length - 1} that waited behind it. One answer replies to them all.`
        : `Record #${one.seq}, tagged ${(ofTurn.find((record) => record.seq === one.seq)?.tags ?? []).join(", ")}. It is in the journal before the model sees anything.`,
    }),
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
    // Memory compacted while it built this call's context: a summary stored between the last context and this one.
    const after = index === 0 ? -Infinity : (board.contexts.get(turn)?.[index - 1]?.upTo ?? Infinity)
    const upTo = board.contexts.get(turn)?.[index]?.upTo ?? Infinity
    const stored = compactions.filter((record) => record.seq > after && record.seq <= upTo)
    const unstored = index === 0 && compactions.length === 0 && summarized > 0
    if (stored.length > 0 || unstored) {
      raw.push({
        id: `compacted-${n}`, kind: "compacted", call: n, label: at(stored.length > 0 ? "Memory compacted" : "Memory asked for a summary"), code: "summarizer.summarize({ earlier, messages })", column: "journal",
        happened: true, seqs: stored.map((record) => record.seq),
        detail: stored.length > 0
          ? `Over its budget, memory asked the summarizer for a summary of older turns, in a model call of its own (${plural(summarized, "summarizer call")} this turn), and stored it once: record ${stored.map((record) => `#${record.seq}`).join(", ")}, tagged memory. Every later context starts with it.`
          : `Memory asked the summarizer ${plural(summarized, "time")}, and stored no summary: the summary failed, or the context was still over the budget.`,
      })
    }
    raw.push({
      id: `context-${n}`, kind: "context", call: n, label: at("Memory built the context"), code: "memory.context(session)", column: "memory", happened: Option.isSome(view.memory), seqs: inContext,
      detail: Option.isSome(view.memory)
        ? `${plural(memoryCount, "message")} from the journal${leftOut > 0 ? `; ${leftOut} left out by memory` : ", nothing left out"}.`
        : restored ? readBack.detail : "Memory reads the journal and picks what the model sees.",
    })
    // Each attempt of this call before its last: a prompt whose stream failed, and the call tried again (lesson 14).
    const last = Option.fromNullishOr(view.attempts.at(-1))
    view.attempts.slice(0, -1).forEach((attempt, place) => {
      const next = view.attempts[place + 1]
      raw.push({
        id: `attempt-${n}-${attempt.attempt}`, kind: "attempt", call: n, label: at(`Attempt ${attempt.attempt} failed`), code: "the plan's step", column: "prompt", happened: true, seqs: [],
        detail: `Attempt ${attempt.attempt}, on ${attempt.model}, failed: ${Option.getOrElse(attempt.failed, () => "its stream failed")}. ${attempt.pieces === 0
          ? "It failed before a word of its answer, so nothing of it was shown or stored."
          : `${plural(attempt.pieces, "piece")} of it reached the chat before it failed.`} Then the call was tried again${next === undefined ? "" : `: attempt ${next.attempt}, on ${next.model}`}.`,
      })
    })
    // The model the last attempt was sent to, said where the call was tried more than once or went to a model other than the one picked.
    const sentTo = Option.filter(last, (one) => view.attempts.length > 1 || Option.exists(picked, (name) => name !== one.model))
    raw.push({
      id: `prompt-${n}`, kind: "prompt", call: n, label: at("Prompt sent"), code: "model.streamText({ prompt })", column: "prompt", happened: Option.isSome(view.prompt), seqs: inContext,
      detail: Option.isSome(view.prompt)
        ? `${Option.match(sentTo, { onNone: () => "", onSome: (one) => `Attempt ${one.attempt}, sent to ${one.model}. ` })}The system text from your code, ${memoryCount} from memory${added > 0 ? `, ${added} added by your code` : ""}: about ${view.promptTokens} tokens, ${view.reusedTokens} the same as the prompt before.${Option.match(Option.flatMap(last, (one) => one.failed), { onNone: () => "", onSome: (reason) => ` Its stream failed, and no attempt came after it: ${reason}.` })}`
        : restored ? readBack.detail : "The prompt is built fresh: the system text, then the context.",
    })
    // A loop on the kernel's two functions: the hints name them, not the lines a loop writes by hand (lessons 1 and 2).
    const byKernel = board.given.get(turn)?.[sentAt(index)] === true
    const streamed = pieces[sentAt(index)] ?? 0
    raw.push(quiet ? {
      id: `streamed-${n}`, kind: "streamed", call: n, label: at("Answer streamed"), code: "hooks.stream (quiet)", column: "prompt", happened: Option.isSome(answer), seqs: [],
      detail: board.kind === "helper"
        ? "A helper's hooks keep its words out of the chat: its answer goes back to its caller as delegate's result."
        : board.kind === "task"
          ? "A task's words stay out of the chat: its answer goes back to the chat's queue as a report, answered in a turn of its own."
          : "This session is not the chat's: what its model says is not drawn in the chat.",
    } : {
      id: `streamed-${n}`, kind: "streamed", call: n, label: at("Answer streamed"), code: "chat.stream(piece)", column: "prompt",
      // Streaming until the answer is stored, so the step stays lit while its words arrive; in a closed turn an answer
      // cut after its first words (lesson 14) streamed too.
      happened: Option.isSome(answer) || (streamed > 0 && Option.isSome(ended)), seqs: [],
      // The count is said once the answer is stored: the tab does not paint on each piece (`paintsOn`), so a count drawn
      // while it streams would stay at its first.
      detail: Option.isSome(answer)
        ? streamed > 0 ? `${plural(streamed, "piece")} streamed to the chat as they arrived.` : "The model streamed no text: it only called tools."
        : streamed > 0 ? "The answer is streaming to the chat, piece by piece." : "Each piece goes to the chat as it arrives.",
    })
    const asked = Option.match(answer, { onNone: () => [], onSome: (one) => one.calls })
    raw.push({
      id: `stored-answer-${n}`, kind: "stored-answer", call: n, label: at(asked.length > 0 ? "Calls stored" : "Answer stored"), code: restored ? readBack.code : byKernel ? "modelAnswer(stream, session)" : "session.append(assistantMessage(…))", column: "journal", happened: Option.isSome(answer), seqs: seqOf(answer),
      detail: Option.match(answer, {
        onNone: () => "The answer goes into the journal, for the next call's context.",
        onSome: (one) => {
          // The model that answered, where it is worth saying: lesson 14's spare.
          const by = Option.match(view.answeredBy, { onNone: () => "", onSome: (name) => `, answered by ${name}` })
          return asked.length > 0 ? `Record #${one.seq}${by}: the model asked for ${plural(asked.length, "tool call")}.` : `Record #${one.seq}${by}. The next turn's memory can read it.`
        },
      }),
    })
    if (asked.length > 0) {
      // The results the journal holds for this step's calls, in the order they were stored.
      const done = asked.flatMap((call) => Option.toArray(call.result)).toSorted((one, other) => one.seq - other.seq)
      const failed = done.filter((result) => result.isFailure).length
      raw.push({
        id: `tools-${n}`, kind: "tools", call: n, label: at("Tools ran"), code: restored ? readBack.code : byKernel ? "callTool(toolkit, call, session)" : "toolkit.handle(call.name, call.params)", column: "journal", happened: done.length === asked.length, seqs: done.map((record) => record.seq),
        detail: done.length === 0 ? `Running ${plural(asked.length, "tool call")}.`
          : `${plural(done.length, "result")} stored${failed > 0 ? `, ${failed} of them failures the model reads` : ""}: ${done.map((record) => `#${record.seq}`).join(", ")}. Then the model is asked again.`,
      })
    }
  }
  raw.push({
    id: "closed", kind: "closed", call: 0, label: "Turn closed", code: "the scope ends", column: "journal", happened: Option.isSome(ended), seqs: seqOf(ended),
    detail: Option.match(ended, { onNone: () => "The turn closes when its scope ends: answered, failed or stopped.", onSome: (one) => `Record #${one.seq}: ${outcomeText(one)}.` }),
  })

  const closed = Option.map(ended, outcomeText)
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
  return { turn, restored, readBack, closed, steps, calls }
}

// ── the sessions a page hears of ────────────────────────────────────────────

/** Everything the Context tab holds: one board per session a turn ran in, in the order they appeared, the chat's first. */
export interface Boards {
  /** The conversation the chat shows. */
  readonly chat: string
  readonly boards: ReadonlyMap<string, Board>
  /** What was heard of each session's header (a `Session` trace), by its id. */
  readonly headers: ReadonlyMap<string, SessionSeen>
  /** Sessions of a conversation Clear context left: what they still announce is not this conversation's. */
  readonly retired: ReadonlySet<string>
}

export const emptyBoards = (chat: string): Boards => ({ chat, boards: new Map([[chat, emptyBoard(chat)]]), headers: new Map(), retired: new Set() })

/** The session a trace is about: an event's, a context's, a prompt's and its failure's, a usage's, a header's and a curator's call's own; anything the program told the chat is the chat's. */
export const sessionOfTrace = (trace: Trace, chat: string): string =>
  trace._tag === "Event" ? trace.event.session
    : trace._tag === "Context" || trace._tag === "Prompt" || trace._tag === "PromptFailed" || trace._tag === "Usage" || trace._tag === "Session" || trace._tag === "CuratorAnswered" || trace._tag === "CurationCut" ? trace.session
      : chat

/**
 * The boards after one more trace, heard `at` ms after they started: the trace is filed under its own session's
 * board, made when the session is first heard of with the kind its header gives. A session's header (`Session`)
 * is kept for that, and makes no board: a session has one once a turn runs in it. A retired session's traces are
 * passed over.
 */
export const heardBy = (all: Boards, trace: Trace, at: number): Boards => {
  const session = sessionOfTrace(trace, all.chat)
  if (all.retired.has(session)) return all
  if (trace._tag === "Session") {
    const headers = new Map(all.headers).set(session, { owner: trace.owner, parent: Option.fromNullishOr(trace.parent) })
    // The header is heard before the session's first record. Should a board be there already, it takes the kind the header gives.
    const held = all.boards.get(session)
    const boards = held === undefined ? all.boards : new Map(all.boards).set(session, { ...held, kind: kindOf(session, all.chat, Option.fromNullishOr(headers.get(session))) })
    return { ...all, headers, boards }
  }
  const known = all.boards.get(session) ?? emptyBoard(session, kindOf(session, all.chat, Option.fromNullishOr(all.headers.get(session))))
  return { ...all, boards: new Map(all.boards).set(session, record(known, trace, at)) }
}

/**
 * The boards as a new conversation starts (Clear context, or a durable lesson's program naming another one): an
 * empty board for the new chat, and every other session retired with its board, but the memory session's and the
 * knowledge session's. Neither is a conversation's: each board stays, with the records heard so far, and goes on being
 * heard.
 */
export const startedOver = (all: Boards, chat: string): Boards => {
  const kept = [...all.boards].filter(([session, board]) => session !== chat && (board.kind === "memory" || board.kind === "knowledge"))
  const gone = [...all.boards.keys()].filter((session) => session !== chat && !kept.some(([id]) => id === session))
  return {
    chat,
    boards: new Map([[chat, emptyBoard(chat)], ...kept]),
    headers: new Map([...all.headers].filter(([session]) => kept.some(([id]) => id === session))),
    retired: new Set([...all.retired, ...gone].filter((session) => session !== chat)),
  }
}

/** One button of the Context tab's row of sessions. */
export interface SessionTab {
  readonly session: string
  readonly kind: SessionKind
  /** The button's text. */
  readonly label: string
  /** What the button says of the session when pointed at. */
  readonly title: string
}

/** What a session was first asked: its first user message, a helper's task. */
const taskOf = (board: Board): string => {
  const first = board.records.find((one) => one.message?._tag === "User")?.message
  return first?._tag === "User" ? first.text : ""
}

/**
 * The row of sessions: the chat's first, then each other session in the order it appeared, named for what it is.
 * A helper is numbered among the helpers and named by its task, and a background task among the tasks (lesson 17);
 * the memory session and the knowledge session are "Memory"; a session that is none of these is numbered among
 * its like, with its owner.
 */
export const sessionRow = (all: Boards): ReadonlyArray<SessionTab> => {
  const counts = { helper: 0, task: 0, other: 0 }
  return [...all.boards].map(([session, board]): SessionTab => {
    const header = Option.fromNullishOr(all.headers.get(session))
    const kind = kindOf(session, all.chat, header)
    if (kind === "chat") return { session, kind, label: "Chat", title: "The chat's session" }
    if (kind === "memory") return { session, kind, label: "Memory", title: `The memory session: it holds the facts the agent remembers, in a journal of its own, for every conversation: ${session}` }
    if (kind === "knowledge") return { session, kind, label: "Memory", title: `The knowledge session: what the curator kept of each turn, in a journal of its own, for every conversation: ${session}` }
    const task = taskOf(board)
    const named = task.length > 0 ? `: ${task}` : ""
    const under = Option.exists(header, ({ parent }) => Option.contains(parent, all.chat)) ? "the chat's" : "another session's"
    if (kind === "helper") return { session, kind, label: `Helper ${++counts.helper}${named}`, title: `A helper's session, a child of ${under}: ${session}` }
    if (kind === "task") return { session, kind, label: `Task ${++counts.task}${named}`, title: `A background task's session, a child of ${under}, owned by the tasks plugin: ${session}` }
    const owner = Option.match(header, { onNone: () => "", onSome: (seen) => `, owned by ${seen.owner}` })
    return { session, kind, label: `Session ${++counts.other}${named}`, title: `A session of the program's own${owner}: ${session}` }
  })
}
