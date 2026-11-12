import { Match, Result } from "effect"
import { AgentRefused } from "./agent.entity.js"
import type { AgentPhase } from "./agent.entity.js"

const replaced = () => new AgentRefused({ reason: "Replaced", message: "this agent was replaced by `with`; send to the agent it returned" })

/** A turn starts on the handle: one more running, or refused once replaced. */
export const admitTurn = (phase: AgentPhase): Result.Result<AgentPhase, AgentRefused> =>
  Match.valueTags(phase, {
    Live: ({ running }): Result.Result<AgentPhase, AgentRefused> => Result.succeed({ _tag: "Live", running: running + 1 }),
    Replaced: () => Result.fail(replaced()),
  })

/** A turn of the handle ended: one fewer running. */
export const leaveTurn = (phase: AgentPhase): AgentPhase => ({ ...phase, running: Math.max(0, phase.running - 1) })

/** The handle is replaced: it keeps the turns it runs and takes no more. A handle replaced before refuses. */
export const replaceAgent = (phase: AgentPhase): Result.Result<AgentPhase, AgentRefused> =>
  Match.valueTags(phase, {
    Live: ({ running }): Result.Result<AgentPhase, AgentRefused> => Result.succeed({ _tag: "Replaced", running }),
    Replaced: () => Result.fail(replaced()),
  })

/** Whether a replaced handle has finished its last turn, so its parts can close. */
export const isDrained = (phase: AgentPhase): boolean => phase._tag === "Replaced" && phase.running === 0
