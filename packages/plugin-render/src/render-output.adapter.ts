import { Effect, Layer, Schema } from "effect"
import { definePlugin } from "@xandreed/core"
import type { Failure } from "@xandreed/core"
import { UiOutputError, UiOutputProposal } from "./domain/render-output.entity.js"
import { UiOutput, UiOutputAdmission, UiOutputContext, UiOutputJournal, UiOutputTools } from "./ports/render-output.port.js"
import { uiOutputToolkit } from "./render-output.tools.js"

/** @public */
export const UiOutputLive = (maxBytes = 32_768) => Layer.effect(UiOutput, Effect.gen(function* () {
  const admission = yield* UiOutputAdmission
  const journal = yield* UiOutputJournal
  const scope = yield* UiOutputContext
  return UiOutput.of({
    emit: Effect.fn("render.emit")(function* (input: UiOutputProposal) {
      const proposal = yield* Schema.decodeUnknownEffect(UiOutputProposal)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new UiOutputError({ code: "invalid", message: "Invalid component proposal" })),
      )
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(UiOutputProposal))(proposal).pipe(
        Effect.mapError(() => new UiOutputError({ code: "invalid", message: "Component must be serializable" })),
      )
      if (new TextEncoder().encode(json).byteLength > maxBytes) return yield* Effect.fail(new UiOutputError({ code: "invalid", message: "Component exceeds the configured size limit" }))
      yield* admission.validate(scope, proposal)
      return yield* journal.commit(scope, proposal)
    }),
  })
}))

/** Each `UiOutputError` code (the host's, which spans and logs keep) as the name `render_component` returns it to the model under. */
const failureNames: Readonly<Record<UiOutputError["code"], string>> = {
  invalid: "InvalidComponent",
  forbidden: "ComponentNotAllowed",
  unavailable: "RendererUnavailable",
  conflict: "OperationIdReused",
  storage: "StorageUnavailable",
}

/** A refusal as the model reads it: its name and the message (admission's and the journal's are the host's). */
const modelFailure = (error: UiOutputError): Failure => ({ error: failureNames[error.code], message: error.message })

/** @public */
export const UiOutputHandlersLive = uiOutputToolkit.toLayer(Effect.gen(function* () {
  const output = yield* UiOutput
  return { render_component: (proposal: UiOutputProposal) => output.emit(proposal).pipe(Effect.mapError(modelFailure)) }
}))

/**
 * Transport-independent: WebSocket/SSE hosts consume the committed journal.
 *
 * @public
 */
export const uiOutputPlugin = definePlugin({
  id: "@xandreed/plugin-render/output", version: "0.14.0",
  requires: [UiOutputAdmission, UiOutputJournal, UiOutputContext],
  provides: [UiOutput, UiOutputTools],
  config: Schema.Struct({ maxBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1024, maximum: 131_072 }))) }),
  defaults: { maxBytes: 32_768 },
  layer: ({ maxBytes }) => Layer.merge(UiOutputLive(maxBytes), Layer.succeed(UiOutputTools, { toolkit: uiOutputToolkit })),
})
