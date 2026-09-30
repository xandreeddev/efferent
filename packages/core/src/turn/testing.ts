import { Effect, Option, Ref } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { TurnDraft, TurnWriter } from "../ports/sessions.port.js"
import { turnStartedDraft } from "../session/session-event.entity.functions.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { UserMessage } from "./user-message.entity.js"

/**
 * A turn writer that keeps the session's events in memory, for testing the
 * turn's pieces without a sessions plugin: the turn is begun (its
 * `turn.started` stored) over `history`, writes are stored at once, and the
 * turn is never closed from outside.
 */
export const recordingTurnWriter = (input: {
  readonly runId: string
  readonly text: string
  readonly turn?: number
  readonly history?: ReadonlyArray<SessionLogEvent>
  readonly conversation?: ConversationId
}) => Effect.gen(function* () {
  const session = input.conversation ?? ConversationId.make("00000000-0000-4000-8000-00000000abcd")
  const turn = input.turn ?? 1
  const history = input.history ?? []
  const userMessage = new UserMessage({ text: input.text })
  const draft = yield* turnStartedDraft(turn, {
    runId: input.runId, key: input.runId, origin: "user", userMessage, command: {}, claimed: [], entry: EntryId.make(`${input.runId}:0`), at: 0,
  }).pipe(Effect.orDie)
  const started: SessionLogEvent = { session, seq: history.length + 1, turn: draft.turn, kind: draft.kind, at: 0, data: draft.data }
  const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([...history, started])
  const append = (drafts: ReadonlyArray<TurnDraft>) => Ref.update(stored, (all) => [...all, ...drafts.map((next, index): SessionLogEvent => ({
    session, seq: all.length + index + 1, turn: Option.some(turn), kind: next.kind, at: 0, data: JSON.parse(JSON.stringify(next.data)),
  }))])
  const writer: TurnWriter = {
    admitted: { session: { id: session, owner: "test" }, turn, runId: input.runId, key: input.runId, origin: "user", userMessage, command: {}, claimed: [] },
    started,
    history: (kinds) => Effect.succeed(history.filter((event) => kinds.length === 0 || kinds.includes(event.kind))),
    snapshot: (kinds, after) => Ref.get(stored).pipe(Effect.map((events) => (after === undefined ? events : events.slice(history.length).filter((event) => event.seq > after))
      .filter((event) => kinds.length === 0 || kinds.includes(event.kind)))),
    append,
    write: (op) => op,
    transact: (decide) => decide([]).pipe(Effect.flatMap((decision) => append(decision.drafts).pipe(Effect.as({ result: decision.result, events: [] })))),
    flush: Effect.void,
    end: (ending) => append([{ kind: "turn.ended", data: { reason: ending.reason, failure: null } }]).pipe(Effect.as({ pending: 0 })),
    closed: Effect.never,
  }
  return { writer, stored, kinds: Ref.get(stored).pipe(Effect.map((all) => all.map((event) => event.kind))) }
})
