import { Context, Effect, Layer } from "effect"
import { ModelSpend, ModelSpendMemoryLive } from "@xandreed/core"
import type { EvaluationApp } from "../contracts/evaluation-app.contract.js"
import { EvaluationError } from "../domain/identity.entity.js"
import { EvaluationServices } from "../ports/evaluation-services.port.js"
import { TrialRecorder } from "../ports/trial-recorder.port.js"
import { runSpendLedger } from "./run-spend.adapter.js"

/**
 * Layer construction belongs at the eval runtime edge, outside application use cases.
 * A run's spend ledger is a fresh in-memory `ModelSpend` (`ModelSpendMemoryLive`).
 */
export const EvaluationServicesLive = (app: EvaluationApp) =>
  Layer.succeed(EvaluationServices, {
    execution: (runnableId, environmentId, recorder) =>
      Effect.suspend(() => {
        const runnable = app.runnables.find(
          (entry) => entry.definition.id === runnableId
        )
        const environment = runnable?.environments.find(
          (entry) => entry.id === environmentId
        )
        return !runnable || !environment
          ? Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `No runnable/environment for ${runnableId}`
              })
            )
          : Layer.build(
              Layer.mergeAll(
                Layer.fresh(environment.layer),
                Layer.succeed(TrialRecorder, recorder)
              )
            )
      }),
    projection: (id) =>
      Effect.suspend(() => {
        const registration = app.projections.find(
          (entry) => entry.definition.id === id
        )
        return registration
          ? Layer.build(Layer.fresh(registration.layer))
          : Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `No projection ${id}`
              })
            )
      }),
    grading: (id) =>
      Effect.suspend(() => {
        const registration = app.graders.find(
          (entry) => `${entry.definition.id}@${entry.definition.version}` === id
        )
        return registration
          ? Layer.build(Layer.fresh(registration.layer))
          : Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `No grader ${id}`
              })
            )
      }),
    spend: (budget) =>
      Layer.build(Layer.fresh(ModelSpendMemoryLive)).pipe(
        Effect.flatMap((context) => runSpendLedger(Context.get(context, ModelSpend), budget))
      )
  })
