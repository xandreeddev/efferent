import { Context } from "effect"
import type { Effect } from "effect"
import type { EvaluationError } from "../domain/identity.entity.js"

/** Durable execution admission I/O, recorded after a world opens and before its subject runs. */
export class ExecutionReceipt extends Context.Service<ExecutionReceipt, {
  readonly recordOpened: Effect.Effect<void, EvaluationError>
}>()("efferent/evals/ExecutionReceipt") {}
