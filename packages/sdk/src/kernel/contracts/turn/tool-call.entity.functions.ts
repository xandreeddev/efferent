import { Context, Effect, Option, Predicate, Stream } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import { toolResult } from "@xandreed/core/kernel"
import type { JournalStorageError, ListenerFailed, OpenSession, SessionRefused, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { CurrentTurn } from "./current-turn.port.js"
import { runningTurn } from "./running-turn.entity.functions.js"
import { SentWhole } from "./sent-whole.port.js"
import { OUTCOME_ATTRIBUTE } from "./telemetry.entity.js"
import { countTool } from "./telemetry.entity.functions.js"

/**
 * A tool call as the model made it: its id, the tool's name and its parameters. Neither the name nor the
 * parameters is checked: a model can name a tool that is not offered and send parameters that do not fit, so the
 * name is any text and the parameters any value. The toolkit checks both when the call is run.
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
 * What a call of a toolkit's tools needs from the program that makes it: every service its tools declare in
 * `dependencies`, and what their schemas need to decode and encode, less the turn, which `callTool` gives each
 * call. A program that calls `callTool` and leaves one out does not compile. For a toolkit whose tools declare
 * nothing but `CurrentTurn`, it is `never`.
 *
 * @public
 */
export type ToolNeeds<Tools extends Record<string, Tool.Any>> = Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CurrentTurn>

/**
 * A toolkit whose every tool has its own type. A tool typed `Tool.Any` has lost what it declares, so `ToolNeeds`
 * of a toolkit that holds one (a `Record<string, Tool.Any>`, or one such tool among its own) is `any`, which
 * names no dependency: none can be found missing. `callTool` refuses such a toolkit where it is passed, in these
 * words. The test is of `ToolNeeds` itself (`0 extends 1 & T` holds for `any` alone).
 *
 * @public
 */
export type OwnTools<Tools extends Record<string, Tool.Any>> = 0 extends 1 & ToolNeeds<Tools>
  ? "callTool needs each tool's own type: a toolkit with a tool typed Tool.Any has lost what its tools declare"
  : unknown

/**
 * The model's call, handed to the toolkit. The model wrote the name and the parameters, so the compiler cannot know
 * which tool it is or that its parameters fit: the toolkit checks both when it handles the call, and fails one it
 * cannot take, which `callTool` stores as a failed result. These two are the only type assertions on a tool's
 * path. The call is typed over every tool of the toolkit, never over one name, so what any tool needs stays in
 * the type of the effect.
 */
const handled = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.WithHandler<Tools>, call: ModelToolCall) =>
  toolkit.handle<keyof Tools>(call.name as keyof Tools, call.params as Tool.ParametersEncoded<Tools[keyof Tools]>)

/**
 * Run one call the model made, in the turn it belongs to, and store its
 * result: the tool's answer, or a failed result the model reads (the tool's
 * own failure, an unknown tool, parameters the toolkit refused, or a defect
 * in a handler, a write of its own that failed included). The stored record
 * is returned. The turn is provided as `CurrentTurn`, so a tool that
 * declares it reaches the session; every other service a tool declares is
 * the program's to provide, and is in this effect's type (`ToolNeeds`), so
 * the toolkit is passed with its own type (`OwnTools`). A
 * tool annotated `SentWhole` has its result stored as `whole`, a failed one
 * too. It fails only when the result cannot be stored.
 *
 * The call is a span, `tool.call`, opened with the tool's name and the
 * call's id and closed with whether its result is a failure
 * (`efferent.outcome`); a tool's own spans are under it. The parameters and
 * the result are not put on it: Effect AI's toolkit puts the parameters on
 * the span current where a call is handled, which is this one, and the
 * export drops them unless the host turned content on (ADR 0030). The call
 * is counted (`efferent.tool.calls`, by tool and outcome).
 *
 * @public
 */
export const callTool = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools> & OwnTools<Tools>,
  call: ModelToolCall,
  session: OpenSession,
): Effect.Effect<StoredEvent, JournalStorageError | ListenerFailed | SessionRefused, ToolNeeds<Tools>> => {
  const options = { whole: sentWhole(toolkit.tools, call.name) }
  const ran = (result: unknown, failed: boolean): Ran => ({ draft: toolResult(call, result, failed, options), failed })
  return handled<Tools>(toolkit, call).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(Option.match({
      onNone: () => ran(null, false),
      onSome: (last) => ran(last.encodedResult, last.isFailure),
    })),
    Effect.catch((error) => Effect.succeed(ran(failureText(error), true))),
    Effect.catchDefect((defect) => Effect.succeed(ran(failureText(defect), true))),
    Effect.provideService(CurrentTurn, runningTurn(session)),
    Effect.tap(({ failed }) => Effect.andThen(
      Effect.annotateCurrentSpan(OUTCOME_ATTRIBUTE, failed ? "failed" : "succeeded"),
      countTool(Object.hasOwn(toolkit.tools, call.name) ? Option.some(call.name) : Option.none(), failed),
    )),
    // A result that is not stored answers nothing: the next context would send the call without it.
    Effect.flatMap(({ draft }) => session.append(draft)),
    Effect.withSpan("tool.call", {
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.name.slice(0, NAME_SHOWN), "gen_ai.tool.call.id": call.id.slice(0, NAME_SHOWN) },
    }),
  )
}

/** A call's result as it is stored, and whether it is a failure. */
interface Ran {
  readonly draft: StoredDraft
  readonly failed: boolean
}

/** The most of a name the model wrote that a span carries: a tool's name or a call's id is short, unless the model went wrong. */
const NAME_SHOWN = 200
