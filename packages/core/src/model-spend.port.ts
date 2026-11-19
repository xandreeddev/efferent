import { Context } from "effect"
import type { Effect } from "effect"
import type { ModelSpendExceeded, ModelSpendUnavailable, SpendAmount, SpendHold, SpendRequest, SpendTotals } from "./model-spend.entity.js"

/**
 * The ledger of what model calls cost, shared by every call of one run of spend (a process, an evaluation run). A
 * call's worst case is held before it is sent, and refused when it would take the run past its cap; once the call
 * ends, the hold is settled at what it cost, or released. The ledger holds no conversation: it is no store beside the
 * journal (ADR 0020). Whoever sends a model call reserves; the kernel itself calls no model.
 *
 * A caller runs `reserve` uninterruptibly with what it does with the hold, so a hold the ledger took is always closed.
 *
 * @public
 */
export class ModelSpend extends Context.Service<ModelSpend, {
  /** Hold `request.amount` within `request.caps`, or refuse and hold nothing. */
  readonly reserve: (request: SpendRequest) => Effect.Effect<SpendHold, ModelSpendExceeded | ModelSpendUnavailable>
  /** Close a hold at the call's observed cost, below or above the amount held. Closing a closed hold changes nothing. */
  readonly settle: (hold: SpendHold, cost: SpendAmount) => Effect.Effect<void, ModelSpendUnavailable>
  /** Close a hold with nothing settled. Closing a closed hold changes nothing. */
  readonly release: (hold: SpendHold) => Effect.Effect<void, ModelSpendUnavailable>
  /** What the ledger has settled, and what its open holds still reserve. */
  readonly totals: Effect.Effect<SpendTotals, ModelSpendUnavailable>
}>()("@xandreed/core/ModelSpend") {}
