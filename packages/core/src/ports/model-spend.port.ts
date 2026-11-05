import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { ModelSpendExceeded, ModelSpendUnavailable, SpendAmount, SpendHold, SpendRequest, SpendTotals } from "../domain/model-spend.entity.js"
import type { RunId } from "../domain/run.entity.js"

/**
 * The ledger model sends reserve their spend in: one ledger is one run of
 * spend (a process, an evaluation run), with each turn's share kept apart
 * by its `runId`. A send reserves its worst case before it goes out
 * (`reserve`), then settles at what it cost once its usage is known
 * (`settle`), or releases the hold when it cost nothing (`release`).
 * `reserve` is atomic: concurrent reservations never take what is settled
 * and held past a cap, and a refusal (`ModelSpendExceeded`, an error the
 * caller handles) holds nothing. Callers run `reserve` uninterruptibly, so
 * a hold the ledger has taken always reaches the attempt that closes it: a
 * ledger that waits on a shared store bounds that wait itself and fails
 * with `ModelSpendUnavailable` past it. `settle` and `release` of a hold the
 * ledger no longer has do nothing, so each is safe to repeat. Once a turn
 * has ended, `forget` drops what the ledger keeps for it alone, so a ledger
 * that lives as long as its process does not grow with every turn.
 * `ModelSpendUnavailable` is a ledger that cannot be reached; the in-memory
 * ledger (`ModelSpendMemoryLive`) never fails so. `modelSpendConformance`
 * is the contract as runnable checks.
 *
 * @public
 */
export class ModelSpend extends Context.Service<ModelSpend, {
  /** Hold `request.amount` within `request.caps`, or refuse. */
  readonly reserve: (request: SpendRequest) => Effect.Effect<SpendHold, ModelSpendExceeded | ModelSpendUnavailable>
  /** Close a hold at the send's observed cost, below or above the amount held. */
  readonly settle: (hold: SpendHold, cost: SpendAmount) => Effect.Effect<void, ModelSpendUnavailable>
  /** Close a hold with nothing settled. */
  readonly release: (hold: SpendHold) => Effect.Effect<void, ModelSpendUnavailable>
  /**
   * Forget the ended turn `runId`: its own totals read nothing once every
   * hold it still has is closed (until then they keep counting toward its
   * cap); what it settled stays in the whole ledger's. The turn calls it as
   * its scope closes, after its last model call.
   */
  readonly forget: (runId: RunId) => Effect.Effect<void, ModelSpendUnavailable>
  /** What one turn (`runId`), or the whole ledger (none), has settled and still holds. */
  readonly totals: (runId: Option.Option<RunId>) => Effect.Effect<SpendTotals, ModelSpendUnavailable>
}>()("@xandreed/core/ModelSpend") {}
