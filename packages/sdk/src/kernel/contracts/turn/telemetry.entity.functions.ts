import { Effect, Metric, Option } from "effect"
import { OUTCOME_ATTRIBUTE, TOOL_ATTRIBUTE, toolCalls, UNKNOWN } from "./telemetry.entity.js"

/** Count one tool call: by the tool it ran (`unknown` for a name the toolkit has not) and whether its result is a failure. */
export const countTool = (tool: Option.Option<string>, failed: boolean): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(toolCalls, { [TOOL_ATTRIBUTE]: Option.getOrElse(tool, () => UNKNOWN), [OUTCOME_ATTRIBUTE]: failed ? "failed" : "succeeded" }), 1)
