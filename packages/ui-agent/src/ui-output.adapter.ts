import { Effect, Layer, Schema } from "effect"
import { definePlugin } from "@xandreed/core"
import { UiOutputError, UiOutputProposal } from "./domain/ui-output.entity.js"
import { UiOutput, UiOutputAdmission, UiOutputContext, UiOutputJournal, UiOutputTools } from "./ports/ui-output.port.js"
import { uiOutputToolkit } from "./ui-output.tools.js"

export const UiOutputLive = (maxBytes = 32_768) => Layer.effect(UiOutput, Effect.gen(function* () {
  const admission = yield* UiOutputAdmission
  const journal = yield* UiOutputJournal
  const scope = yield* UiOutputContext
  return UiOutput.of({
    emit: (input) => Effect.gen(function* () {
      const proposal = yield* Schema.decodeUnknown(UiOutputProposal)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new UiOutputError({ code: "invalid", message: "Invalid component proposal" })),
      )
      const json = yield* Schema.encode(Schema.parseJson(UiOutputProposal))(proposal).pipe(
        Effect.mapError(() => new UiOutputError({ code: "invalid", message: "Component must be serializable" })),
      )
      if (new TextEncoder().encode(json).byteLength > maxBytes) return yield* Effect.fail(new UiOutputError({ code: "invalid", message: "Component exceeds the configured size limit" }))
      yield* admission.validate(scope, proposal)
      return yield* journal.commit(scope, proposal)
    }),
  })
}))

export const UiOutputHandlersLive = uiOutputToolkit.toLayer(Effect.gen(function* () {
  const output = yield* UiOutput
  return { render_component: (proposal: UiOutputProposal) => output.emit(proposal).pipe(
    Effect.mapError((error) => ({ error: error.code, message: error.message })),
  ) }
}))

/** Transport-independent: WebSocket/SSE hosts consume the committed journal. */
export const uiOutputPlugin = definePlugin({
  id: "@xandreed/ui-agent/output", version: "0.2.0-next.0",
  requires: [UiOutputAdmission, UiOutputJournal, UiOutputContext],
  provides: [UiOutput, UiOutputTools],
  config: Schema.Struct({ maxBytes: Schema.Int.pipe(Schema.between(1024, 131_072)) }),
  defaults: { maxBytes: 32_768 },
  layer: ({ maxBytes }) => Layer.merge(UiOutputLive(maxBytes), Layer.succeed(UiOutputTools, { toolkit: uiOutputToolkit })),
})
