// What the context inspector draws, worked out from the session's journal
// and nothing else: every request the session sent is in it
// (`plugin.loop.request.sent`, its messages as pointers), and `requestsOf`
// turns the pointers back into exactly what the model was sent. So it works
// for any memory. Pure: no DOM, no services, tested on its own.
import { Option, Result } from "effect"
import { dataOf, messageOf, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { StoredEvent, TurnOutcome } from "@xandreed/core/kernel"
import { estimateTokens, requestsOf, userMessageEvent } from "@xandreed/sdk/kernel"
import type { InspectedRequest, RequestRefused } from "@xandreed/sdk/kernel"

/** A record of the journal, with the turn it belongs to. */
export interface JournalRecord {
  readonly seq: number
  readonly name: string
  readonly turn: Option.Option<number>
  readonly data: unknown
  readonly message: Option.Option<string>
}

/** A message the journal holds. */
export interface JournalEntry {
  readonly seq: number
  readonly turn: number
  readonly role: "you" | "agent"
  readonly text: string
  /** The kernel's estimate: a quarter of the characters, rounded up. */
  readonly tokens: number
}

export type LayerKind = "system" | "past" | "current"

/** One part of a request, in the order the model was sent it. */
export interface StackLayer {
  readonly kind: LayerKind
  readonly role: "system" | "user" | "assistant"
  readonly text: string
  readonly tokens: number
  /** The same as in the previous request, up to here: a provider's prompt cache could reuse it. */
  readonly reusable: boolean
}

export type EntryStatus = "current" | "shown" | "dropped" | "reply"

export interface EntryView {
  readonly entry: JournalEntry
  readonly status: EntryStatus
  /** How the entry's turn ended, when it did not complete. */
  readonly ended: Option.Option<"Failed" | "Interrupted">
}

export interface RequestView {
  readonly index: number
  readonly turn: number
  readonly step: number
  readonly seq: number
  readonly layers: ReadonlyArray<StackLayer>
  readonly entries: ReadonlyArray<EntryView>
  /** What the model answered to this request: output, so it is not part of the request's own tokens. */
  readonly reply: Option.Option<JournalEntry>
  readonly estimatedTokens: number
  readonly budgetTokens: number
  readonly over: boolean
  /** Against the previous request; none for the first. */
  readonly prefix: Option.Option<{ readonly layers: number; readonly tokens: number; readonly of: number }>
}

/** The last turn, as the Loop view's figures show it. */
export interface TurnStats {
  readonly turn: number
  /** Model requests the turn sent (`plugin.loop.request.sent`). */
  readonly steps: number
  /** Memory's estimate of the turn's last request. */
  readonly sentTokens: number
  /** The kernel's estimate of what the model answered. */
  readonly answeredTokens: number
}

export interface InspectorModel {
  readonly records: ReadonlyArray<JournalRecord>
  readonly journal: ReadonlyArray<JournalEntry>
  readonly requests: ReadonlyArray<RequestView>
  readonly last: Option.Option<TurnStats>
}

/** Each record's turn: the one the last `core.session.turn.started` before it opened. */
export const recordsOf = (events: ReadonlyArray<StoredEvent>): ReadonlyArray<JournalRecord> => {
  let turn = Option.none<number>()
  return events.map((event) => {
    turn = Option.match(dataOf(turnStartedEvent, event), { onNone: () => turn, onSome: (started) => Option.some<number>(started.turn) })
    return { seq: event.seq, name: event.name, turn, data: event.data, message: Option.map(messageOf(event), (message) => message.text) }
  })
}

/** How each turn ended, by its number. */
const outcomesOf = (events: ReadonlyArray<StoredEvent>): ReadonlyMap<number, TurnOutcome> =>
  new Map(events.flatMap((event) => Option.toArray(Option.map(dataOf(turnEndedEvent, event), (ended) => [ended.turn as number, ended.outcome] as const))))

const roleOf = (tag: "User" | "Assistant") => tag === "User" ? "user" as const : "assistant" as const

/** How many leading pointers two requests share. */
const sharedPrefix = (previous: InspectedRequest, current: InspectedRequest): number => {
  let shared = 0
  while (shared < previous.messages.length && shared < current.messages.length && previous.messages[shared]?.seq === current.messages[shared]?.seq) shared += 1
  return shared
}

/**
 * The inspector's model of a session's journal. A stored request that
 * points at no message, or at one stored after it, refuses the journal:
 * the refusal comes back as it is, for the pane to show.
 */
export const inspectorOf = (events: ReadonlyArray<StoredEvent>): Result.Result<InspectorModel, RequestRefused> => Result.map(requestsOf(events), (sent) => {
  const records = recordsOf(events)
  const outcomes = outcomesOf(events)
  const turnAt = new Map(records.map((record) => [record.seq, Option.getOrElse(record.turn, () => 0)] as const))
  const journal: ReadonlyArray<JournalEntry> = events.flatMap((event) => Option.toArray(Option.map(messageOf(event), (message): JournalEntry => ({
    seq: event.seq, turn: turnAt.get(event.seq) ?? 0, role: message._tag === "User" ? "you" : "agent", text: message.text, tokens: estimateTokens(message.text),
  }))))
  // The message each turn answers: its `plugin.loop.user.message`.
  const asked = new Map(events.filter((event) => event.name === userMessageEvent.name).map((event) => [turnAt.get(event.seq) ?? 0, event.seq as number] as const))
  const endedOf = (turn: number): EntryView["ended"] => Option.flatMap(Option.fromNullishOr(outcomes.get(turn)), (outcome) =>
    outcome._tag === "Completed" ? Option.none() : Option.some(outcome._tag))

  const requests = sent.map((request, index): RequestView => {
    const turn = turnAt.get(request.seq) ?? 0
    const current = asked.get(turn)
    const previous = Option.fromNullishOr(index > 0 ? sent[index - 1] : undefined)
    // A changed system text starts a new prefix: nothing after it can be reused either.
    const shared = Option.map(previous, (before) => before.system === request.system ? 1 + sharedPrefix(before, request) : 0)
    const layers = [
      { kind: "system" as const, role: "system" as const, text: request.system },
      ...request.messages.map(({ seq, message }) => ({ kind: seq === current ? "current" as const : "past" as const, role: roleOf(message._tag), text: message.text })),
    ].map((layer, at): StackLayer => ({ ...layer, tokens: estimateTokens(layer.text), reusable: Option.exists(shared, (count) => at < count) }))
    const pointed = new Set<number>(request.messages.map((message) => message.seq))
    const until = sent[index + 1]?.seq ?? Number.POSITIVE_INFINITY
    const reply = journal.find((entry) => entry.role === "agent" && entry.turn === turn && entry.seq > request.seq && entry.seq < until)
    const before = journal.filter((entry) => entry.seq < request.seq).map((entry): EntryView => ({
      entry,
      status: entry.seq === current ? "current" : pointed.has(entry.seq) ? "shown" : "dropped",
      ended: endedOf(entry.turn),
    }))
    const total = layers.reduce((sum, layer) => sum + layer.tokens, 0)
    return {
      index, turn, step: request.step, seq: request.seq, layers,
      entries: reply === undefined ? before : [...before, { entry: reply, status: "reply", ended: Option.none() }],
      reply: Option.fromNullishOr(reply),
      estimatedTokens: request.estimatedTokens, budgetTokens: request.budgetTokens, over: request.estimatedTokens > request.budgetTokens,
      prefix: Option.map(shared, (count) => ({
        layers: count,
        tokens: layers.filter((layer) => layer.reusable).reduce((sum, layer) => sum + layer.tokens, 0),
        of: total,
      })),
    }
  })

  const lastTurn = Option.flatMap(Option.fromNullishOr(records.at(-1)), (record) => record.turn)
  const last = Option.map(lastTurn, (turn): TurnStats => {
    const ofTurn = requests.filter((request) => request.turn === turn)
    return {
      turn,
      steps: ofTurn.length,
      sentTokens: ofTurn.at(-1)?.estimatedTokens ?? 0,
      answeredTokens: journal.filter((entry) => entry.turn === turn && entry.role === "agent").reduce((sum, entry) => sum + entry.tokens, 0),
    }
  })
  return { records, journal, requests, last }
})
