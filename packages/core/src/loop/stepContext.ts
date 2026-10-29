import { Context, Option } from "effect"
/** Correlation only; unset for work outside the agent loop. */
export const CurrentAgentStep = Context.Reference<Option.Option<number>>("@xandreed/core/CurrentAgentStep", { defaultValue: () => Option.none() })

/** The tool call a handler is running for: the ids its `tool.started`, `tool.progress` and `tool.completed` events share. */
export interface ToolInvocation {
  readonly invocationId: string
  readonly tool: string
  readonly step: number
}

/** Set by the tool registry around each handler call; none outside a tool. */
export const CurrentToolInvocation = Context.Reference<Option.Option<ToolInvocation>>("@xandreed/core/CurrentToolInvocation", { defaultValue: () => Option.none() })
