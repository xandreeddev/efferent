import { Context } from "effect"
import type { Effect } from "effect"
import type { CurrentTurn } from "./contracts/turn/current-turn.port.js"

/** A stand-in contract for the wrapping tests: any contract a part reads and nothing else is needed for. */
export class Label extends Context.Service<Label, { readonly system: string }>()("@xandreed/sdk/kernel/testing/Label") {}

// #region helper-contract
// What the delegate tool needs: a helper that takes a task and answers it, under the turn the call runs in.
// A contract, so the tool does not know how.
export class Helper extends Context.Service<Helper, {
  readonly ask: (task: string) => Effect.Effect<{ readonly answer: string; readonly session: string }, string, CurrentTurn>
}>()("@xandreed/sdk/kernel/testing/Helper") {}
// #endregion helper-contract
