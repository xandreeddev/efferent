import { Context, Effect, Metric, Option, Tracer } from "effect"
import { OUTCOME_ATTRIBUTE, TOOL_ATTRIBUTE, toolCalls, UNKNOWN } from "./telemetry.entity.js"

/** Count one tool call: by the tool it ran (`unknown` for a name the toolkit has not) and whether its result is a failure. */
export const countTool = (tool: Option.Option<string>, failed: boolean): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(toolCalls, { [TOOL_ATTRIBUTE]: Option.getOrElse(tool, () => UNKNOWN), [OUTCOME_ATTRIBUTE]: failed ? "failed" : "succeeded" }), 1)

/**
 * Run `effect` as a trace of its own: with no parent span, so its first span is a root. A plugin forks its long work
 * this way (the inbox's worker and its announcements, a task's turn), since a forked fiber keeps the span current
 * where it was forked as its parent, and that span (the `inbox.enqueue` of the message that started a worker, the
 * `tasks.start` of a tool call) ends long before the work does, and would hold every turn the worker runs in its trace.
 */
export const ownTrace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  // The parent span is the fiber's, never a service an effect requires: leaving it out takes nothing `R` names, which
  // `omit`'s type (the services less the one left out) cannot say of an `R` it does not know.
  Effect.updateContext(effect, (context: Context.Context<R>) => Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>)
