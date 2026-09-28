import { Effect, Layer, Schema } from "effect"
import type { Context } from "effect"
import { EvaluationError } from "./decision.entity.js"
import type { DecisionQuestions, RenderedDecision } from "./decision.entity.js"
import { validateAnswers } from "./decision.entity.functions.js"
import { EvaluationModel } from "./ports/evaluation-model.port.js"

/** What an evaluation transport is sent: the model, the state and the questions. */
export interface EvaluationWire {
  readonly model: string
  readonly state: string
  readonly questions: DecisionQuestions
}

export interface EvaluationModelOptions {
  /** The evaluation model's id, sent on the wire and recorded on the span. */
  readonly model: string
  /** The host's call to its evaluation endpoint; it resolves to `{ answers }` in the wire form. */
  readonly transport: (wire: EvaluationWire, signal: AbortSignal) => PromiseLike<unknown>
  /** Per call (default 10 000). */
  readonly timeoutMs?: number
  /** Bytes of `JSON.stringify({ state, questions })` a call may send (default 24 000). */
  readonly maxInputBytes?: number
}

const Response = Schema.Struct({ answers: Schema.Unknown })

/**
 * An EvaluationModel over a host transport: calls are bounded by bytes and
 * by a deadline (abandoned calls are aborted), and the answers must answer
 * exactly the questions asked, choosing only offered choices.
 */
export const makeEvaluationModel = (options: EvaluationModelOptions): Effect.Effect<Context.Service.Shape<typeof EvaluationModel>, EvaluationError> => Effect.gen(function* () {
  const maxInputBytes = options.maxInputBytes ?? 24_000
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return yield* Effect.fail(new EvaluationError({ code: "invalid", message: "The input limit and the deadline must be positive" }))
  }
  return EvaluationModel.of({
    model: options.model,
    evaluate: (rendered: RenderedDecision) => Effect.gen(function* () {
      const bytes = new TextEncoder().encode(JSON.stringify({ state: rendered.state, questions: rendered.questions })).byteLength
      if (bytes > maxInputBytes) return yield* Effect.fail(new EvaluationError({ code: "budget", message: `The decision is ${bytes} bytes; the limit is ${maxInputBytes}` }))
      const response = yield* Effect.tryPromise({
        try: (signal) => options.transport({ model: options.model, state: rendered.state, questions: rendered.questions }, signal),
        catch: (error) => new EvaluationError({ code: "unavailable", message: String(error) }),
      }).pipe(Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new EvaluationError({ code: "timeout", message: `${options.model} took longer than ${timeoutMs} ms` })),
      }))
      const decoded = yield* Schema.decodeUnknownEffect(Response)(response, { reportInput: true }).pipe(
        Effect.mapError((error) => new EvaluationError({ code: "invalid", message: error.message })),
      )
      return yield* validateAnswers(rendered.questions, decoded.answers)
    }).pipe(Effect.withSpan("ai.evaluate", {
      attributes: {
        "gen_ai.request.model": options.model,
        "efferent.decision.family": rendered.family,
        "efferent.prompt.id": rendered.provenance.id,
        "efferent.prompt.version": rendered.provenance.version,
        "efferent.prompt.variant": rendered.provenance.variant,
        "efferent.prompt.hash": rendered.provenance.hash,
      },
    })),
  })
})

export const EvaluationModelLive = (options: EvaluationModelOptions): Layer.Layer<EvaluationModel, EvaluationError> =>
  Layer.effect(EvaluationModel, makeEvaluationModel(options))

/** An EvaluationModel that answers from a script (in the wire form), checked like any other. */
export const scriptedEvaluationModel = (script: (rendered: RenderedDecision) => unknown, model = "scripted"): Context.Service.Shape<typeof EvaluationModel> =>
  EvaluationModel.of({ model, evaluate: (rendered) => validateAnswers(rendered.questions, script(rendered)) })
