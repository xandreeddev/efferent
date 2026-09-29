import { Context, Option } from "effect"
/** Correlation only; unset for work outside the agent loop. */
export const CurrentAgentStep = Context.Reference<Option.Option<number>>("@xandreed/core/CurrentAgentStep", { defaultValue: () => Option.none() })
