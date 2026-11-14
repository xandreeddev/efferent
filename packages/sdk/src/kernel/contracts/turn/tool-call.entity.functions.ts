import { Effect, Option, Predicate, Stream } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import { toolResult } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { CurrentTurn } from "./current-turn.port.js"

/**
 * A tool call as the model made it: its id, the tool's name and its parameters, unchecked.
 *
 * @public
 */
export interface ModelToolCall {
  readonly id: string
  readonly name: string
  readonly params: unknown
}

/** A failure as the model reads it: its message, or the value itself. */
const failureText = (error: unknown): string => Predicate.hasProperty(error, "message") ? String(error.message) : String(error)

/**
 * Run one call the model made, in the turn it belongs to, and give back its
 * result to store: the tool's answer, or a failed result the model reads (the
 * tool's own failure, an unknown tool, parameters the toolkit refused, or a
 * defect in a handler). The turn is provided as `CurrentTurn`, so a tool that
 * declares it reaches the session. The call's name and parameters are checked
 * by the toolkit, not here.
 *
 * @public
 */
export const callTool = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  call: ModelToolCall,
  session: OpenSession,
) =>
  toolkit.handle(call.name, call.params as Tool.ParametersEncoded<Tools[string]>).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(Option.match({
      onNone: () => toolResult(call, null),
      onSome: (last) => toolResult(call, last.encodedResult, last.isFailure),
    })),
    Effect.catch((error) => Effect.succeed(toolResult(call, failureText(error), true))),
    Effect.catchDefect((defect) => Effect.succeed(toolResult(call, String(defect), true))),
    Effect.provideService(CurrentTurn, session),
  )
