import { Context, Option } from "effect"
import type { InvocationId, RunId, RunRef } from "../domain/run.entity.js"
import type { ToolCallId } from "../domain/message.entity.js"
/** Correlation only; unset for work outside the agent loop. */
export const CurrentAgentStep = Context.Reference<Option.Option<number>>("@xandreed/core/CurrentAgentStep", { defaultValue: () => Option.none() })

/** The exact loop run, including its ordinal; none for direct tool calls outside a loop. @public */
export const CurrentAgentRun = Context.Reference<Option.Option<RunRef>>("@xandreed/core/CurrentAgentRun", { defaultValue: () => Option.none() })

/**
 * The run id of the turn the current work belongs to, from its memory's
 * opening to its last finalizer, helper and utility model calls included;
 * none outside a turn. Set by the turn (`TurnLive`); correlation only.
 * `CurrentAgentRun` is the step loop's run, unset outside the loop.
 *
 * @public
 */
export const CurrentTurnRunId = Context.Reference<Option.Option<RunId>>("@xandreed/core/CurrentTurnRunId", { defaultValue: () => Option.none() })

/** The tool call a handler is running for: the ids its `tool.started`, `tool.progress` and `tool.completed` events share. */
export interface ToolInvocation {
  readonly invocationId: InvocationId
  /** The provider's pairing key, or the loop's deterministic id when omitted by the provider. Absent for direct calls without an id. */
  readonly toolCallId?: ToolCallId
  readonly tool: string
  readonly step: number
}

/** Set by the tool registry around each handler call; none outside a tool. */
export const CurrentToolInvocation = Context.Reference<Option.Option<ToolInvocation>>("@xandreed/core/CurrentToolInvocation", { defaultValue: () => Option.none() })
