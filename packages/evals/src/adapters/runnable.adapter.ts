import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type { Context } from "effect"
import type { RunnableRegistration } from "../contracts/evaluation-app.contract.js"
import type { RunnableExecution } from "../ports/runnable-execution.port.js"
import type { EvaluationEnvironment } from "../ports/evaluation-environment.port.js"
import { TrialExecution } from "../ports/trial-execution.port.js"
import type { Runnable } from "../domain/runnable.entity.js"
import { EvaluationError } from "../domain/identity.entity.js"
import { isEvaluationError, reasonOf } from "../domain/identity.entity.functions.js"

/** Match filesystem JSON serialization while validating the portable value. */
const portable = <A>(schema: Schema.Codec<A>, value: A) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.flatMap((encoded) => Effect.try({
      try: () => JSON.stringify(encoded),
      catch: (error) => new EvaluationError({ code: "invalid", message: `The value does not serialize as JSON: ${reasonOf(Cause.die(error))}`, cause: error })
    })),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json)))
  )

/** Bind specific ports before entering the portable CLI/runtime boundary. */
export const defineRunnable = <I, O, E, W, R, H>(options: {
  readonly definition: Runnable
  readonly input: Schema.Codec<I, unknown>
  readonly output: Schema.Codec<O>
  readonly evidence: Schema.Codec<E>
  readonly runnable: Context.Service<R, RunnableExecution<I, O, E, W>>
  readonly environment: Context.Service<H, EvaluationEnvironment<NoInfer<I>, NoInfer<W>>>
  readonly layer: Layer.Layer<NoInfer<R>, EvaluationError>
  readonly environments: ReadonlyArray<{
    readonly id: string
    readonly layer: Layer.Layer<NoInfer<H>, EvaluationError>
  }>
}): RunnableRegistration => ({
  definition: options.definition,
  environments: options.environments.map((environment) => ({
    id: environment.id,
    layer: Layer.effect(TrialExecution, Effect.gen(function* () {
      const runner = yield* options.runnable
      const host = yield* options.environment
      return TrialExecution.of({
        // Only opening and running are interruptible: a timed-out or cancelled
        // execution still has its world inspected and the outcome recorded
        // (inspection keeps its own deadline) before the interruption goes on.
        execute: (raw, candidate, inspection) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(options.input))(raw).pipe(
            Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `Trial input does not decode: ${error.message}`, cause: error }))
          )
          const world = yield* restore(host.open(input, candidate))
          const attempted = yield* restore(runner.execute(input, candidate, world).pipe(
            Effect.flatMap((result) => Effect.all({
              output: portable(options.output, result.output),
              evidence: portable(options.evidence, result.evidence)
            }, { concurrency: 1 })),
            Effect.mapError((error) => isEvaluationError(error)
              ? error
              : new EvaluationError({ code: "invalid", message: `Trial output or evidence is not portable JSON: ${error.message}`, cause: error }))
          )).pipe(Effect.exit)
          const observed = yield* host.inspect(world).pipe(
            Effect.timeoutOrElse({
              duration: inspection.timeoutMs,
              orElse: () => Effect.fail(new EvaluationError({ code: "timeout", message: "Outcome inspection deadline exceeded" }))
            }),
            Effect.exit
          )
          if (Exit.isSuccess(observed)) yield* inspection.record(observed.value)
          if (Exit.isFailure(attempted)) return yield* Effect.failCause(attempted.cause)
          if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause)
          return attempted.value
        }))
      })
    })).pipe(Layer.provide(Layer.merge(options.layer, environment.layer)))
  }))
})
