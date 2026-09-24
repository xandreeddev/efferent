import { FiberRef, GlobalValue, Option } from "effect"
/** Correlation only; unset for work outside the agent loop. */
export const CurrentAgentStep = GlobalValue.globalValue("@xandreed/core/CurrentAgentStep", () => FiberRef.unsafeMake<Option.Option<number>>(Option.none()))
