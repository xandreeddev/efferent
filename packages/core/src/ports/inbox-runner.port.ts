import { Context } from "effect"
import type { Effect } from "effect"
import type { TurnError } from "../session/sessions.entity.js"
import type { TurnEnding } from "../domain/turn-vocabulary.entity.js"
import type { TurnWriter } from "./sessions.port.js"
import type { TurnOutcome } from "./turn.port.js"

/**
 * Run exactly the supplied prebegun turn, preserving its admitted input and
 * attachments. The caller owns its scope and end: the runner neither begins
 * another turn nor ends this borrowed writer. Completed, partial, failed and waiting
 * outcomes are returned intact; execution failures retain their TurnError.
 * `inboxRunnerConformance` checks this contract.
 */
export class InboxRunner extends Context.Service<InboxRunner, {
  readonly run: (writer: TurnWriter) => Effect.Effect<TurnOutcome, TurnError>
  /**
   * Advisory work after the caller's successful end ACK, outside session
   * serialization and interruptible. A lost ACK or process death may skip
   * it: durable outboxes and reconciliation remain the repair authority.
   * Failure must not reexecute an already-acknowledged input.
   */
  readonly afterEnd?: (writer: TurnWriter, ending: TurnEnding) => Effect.Effect<void, TurnError>
}>()("@xandreed/core/InboxRunner") {}
