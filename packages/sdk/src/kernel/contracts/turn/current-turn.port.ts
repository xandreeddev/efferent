import { Context } from "effect"
import type { Effect, Schema } from "effect"
import type { LiveDefinition, SessionId, StoredDraft, StoredEvent, TurnNumber } from "@xandreed/core/kernel"

/**
 * The open turn as a piece of its work holds it: the session and the turn,
 * its journal, and its two writes. It is an open session whose reads and
 * writes cannot fail in their type: a tool's failures are the ones its
 * schema declares, so a write that fails here is a defect of the work, which
 * the function that gave it its turn answers for (`callTool` stores it as a
 * failed result; `modelAnswer` fails the turn).
 *
 * @public
 */
export interface RunningTurn {
  readonly id: SessionId
  /** The open turn. */
  readonly turn: TurnNumber
  /** The stored events, in order, those this turn appended included. */
  readonly journal: Effect.Effect<ReadonlyArray<StoredEvent>>
  /** Store a record in the turn, then announce it. */
  readonly append: (event: StoredDraft) => Effect.Effect<StoredEvent>
  /** Publish a live event about the turn: stored nowhere. */
  readonly publish: <D extends Schema.Json>(definition: LiveDefinition<D>, data: D) => Effect.Effect<void>
}

/**
 * The turn a piece of work runs for (ADR 0007). Work that must reach the
 * session it runs in (a tool that stores a view or starts a helper, a model
 * wrapper that says what it is doing, a summarizer) reads it with
 * `yield* CurrentTurn`; a tool declares it, `Tool.make(name, { …,
 * dependencies: [CurrentTurn] })`. It is provided by the function that
 * already holds the open session, and by nothing else: `callTool` around a
 * tool's handler, `modelAnswer` while the model's stream runs, and the
 * summary memory around its summarizer. A handler that declares it cannot be
 * run without it: the compiler says so where the call is made.
 *
 * @public
 */
export class CurrentTurn extends Context.Service<CurrentTurn, RunningTurn>()("@xandreed/sdk/kernel/CurrentTurn") {}
