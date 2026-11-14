import { Context, Effect, Option, Predicate, Stream } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import { toolResult } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { CurrentTurn } from "./current-turn.port.js"
import { runningTurn } from "./running-turn.entity.functions.js"
import { SentWhole } from "./sent-whole.port.js"

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

/**
 * Whether the tool a call names asks for its result to be sent whole (`SentWhole`). The name is the model's: it is
 * looked up among the toolkit's own tools only, so a name it does not have, `constructor` included, asks for nothing.
 */
const sentWhole = (tools: Record<string, Tool.Any>, name: string): boolean => {
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined
  return tool !== undefined && Context.getOrElse(tool.annotations, SentWhole, () => false)
}

/** A failure as the model reads it: its message, or the value itself. */
const failureText = (error: unknown): string => Predicate.hasProperty(error, "message") ? String(error.message) : String(error)

/**
 * Run one call the model made, in the turn it belongs to, and store its
 * result: the tool's answer, or a failed result the model reads (the tool's
 * own failure, an unknown tool, parameters the toolkit refused, or a defect
 * in a handler, a write of its own that failed included). The stored record
 * is returned. The turn is provided as `CurrentTurn`, so a tool that
 * declares it reaches the session. A tool annotated `SentWhole` has its
 * result stored as `whole`, a failed one too. The call's name and
 * parameters are checked by the toolkit, not here.
 *
 * @public
 */
export const callTool = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  call: ModelToolCall,
  session: OpenSession,
) => {
  const options = { whole: sentWhole(toolkit.tools, call.name) }
  return toolkit.handle(call.name, call.params as Tool.ParametersEncoded<Tools[string]>).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(Option.match({
      onNone: () => toolResult(call, null, false, options),
      onSome: (last) => toolResult(call, last.encodedResult, last.isFailure, options),
    })),
    Effect.catch((error) => Effect.succeed(toolResult(call, failureText(error), true, options))),
    Effect.catchDefect((defect) => Effect.succeed(toolResult(call, failureText(defect), true, options))),
    Effect.provideService(CurrentTurn, runningTurn(session)),
    // A result that is not stored answers nothing: the next context would send the call without it.
    Effect.flatMap((result) => session.append(result)),
  )
}
