import type { Effect, Schema, Stream } from "effect"
import type { AiError, Tool, Toolkit } from "effect/ai"

/** A validated call. Its private execution closure owns the decoded value. @public */
export interface PreparedToolCall {
  readonly input: Schema.Json
  readonly run: (id?: string) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, AiError.AiError>, AiError.AiError>
}

/** Preparation never starts a handler. All calls may be prepared before any runs. @public */
export interface PreparedToolHandler {
  readonly prepare: (name: string, input: unknown) => Effect.Effect<PreparedToolCall, AiError.AiError>
}

/** An Effect toolkit with an explicit once-only parameter preparation boundary. @public */
export interface PreparedToolkit<Tools extends Record<string, Tool.Any>> extends Toolkit.Toolkit<Tools> {
  readonly execution: Effect.Effect<PreparedToolHandler, never, Tool.HandlersFor<Tools>>
}

/** A registry's execution hook; the identity toolkit retains result codecs and handler context. @public */
export type PreparedToolExecution = (
  toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>,
  call: { readonly name: string; readonly input: Schema.Json; readonly decoded: unknown; readonly id?: string },
) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, AiError.AiError>, AiError.AiError>
