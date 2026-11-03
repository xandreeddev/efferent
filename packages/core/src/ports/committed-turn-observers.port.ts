import { Context } from "effect"
import type { Effect } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { CommittedTurn } from "../turn/committed-turn.entity.js"

/** Optional work after an acknowledged turn end; failures never change its outcome. @public */
export interface CommittedTurnObserver {
  readonly id: string
  readonly committed: (turn: CommittedTurn) => Effect.Effect<void, HarnessError>
}

/**
 * MULTI-provider observers, in graph order. They receive owned turns only
 * after the closing commit succeeds, including failed turns. A host ending
 * a borrowed TurnWriter invokes notifyCommittedTurn after its own end.
 * committedTurnObserversConformance checks notification semantics.
 * @public
 */
export class CommittedTurnObservers extends Context.Service<CommittedTurnObservers, ReadonlyArray<CommittedTurnObserver>>()("@xandreed/core/CommittedTurnObservers") {}
