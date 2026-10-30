export { Agent } from "./agent.adapter.js"
export type { AgentConfig, AgentPluginEntry } from "./agent.adapter.js"
export { agentTaskExecutor } from "./task-executor.adapter.js"

// the turn engine `Agent.turn` runs on, for a host that composes a turn itself
export { TurnLive } from "./turn/turn.adapter.js"
export { cacheKeyOf, runTurnLoop, stepRequestOf } from "./turn/turn-run.usecase.functions.js"
export type { TurnRunServices } from "./turn/turn-run.usecase.functions.js"
export {
  finishTurn,
  guardTurn,
  openTurnTools,
  settleTurn,
  traceTurn,
  traceTurnBegin,
  turnOf,
  turnTools,
} from "./turn/turn-lifecycle.usecase.functions.js"
export type { TurnBeginTrace, TurnTraceOptions } from "./turn/turn-lifecycle.usecase.functions.js"

// Core's names a host writes beside `Agent` when it defines an agent and
// runs its turns, so that code imports one package. Everything else (ports
// to implement and their entities, memory, model requests, stored payloads,
// References) is imported from `@xandreed/core`, its kits from
// `@xandreed/core/conformance`. A name no first-party code imports from
// here is tagged `@public` where it is re-exported.

// a turn's input: the session, the user's message and its images, the run
export { ConversationId, mediaFromBase64, mediaFromBytes, RunId, SessionAddress, UserMessage } from "@xandreed/core"
export type { /** @public */ NewTurn, /** @public */ TurnInput } from "@xandreed/core"
// the turn `use` is given, a run's policy, and what `use` and `Agent.turn` return
export type { Turn, TurnOutcome, /** @public */ TurnPolicy, /** @public */ TurnResult } from "@xandreed/core"

// the sessions turns begin in: their store, its in-memory backend, and admission
export { SessionLog, SessionLogMemoryLive, Sessions, /** @public */ TurnAdmission, TurnAdmissionOpen, /** @public */ TurnRefused } from "@xandreed/core"

// the host's tools, skills, prompt sections and plugins, and what a turn's tools work with
export {
  /** @public */ defineCapability,
  definePlugin,
  definePromptSection,
  /** @public */ defineSkill,
  defineTool,
  Failure,
  Media,
  /** @public */ publishToolProgress,
  SessionEnvironment,
  /** @public */ ActionPolicy,
  /** @public */ PermissionGrants,
} from "@xandreed/core"
export type { Capability } from "@xandreed/core"

// the turn's events, and the journal's records of its messages and its end
export {
  AssistantMessage,
  defineHostEvent,
  onEvent,
  onTool,
  subscribeAll,
  TurnEndedData,
  turnEndedOf,
  TurnEvent,
  TurnEvents,
} from "@xandreed/core"
export type { TurnEventOf, TurnEventsService } from "@xandreed/core"

// what a turn fails with, the guards that tell each, and the code each stands for
export {
  harnessCodeOf,
  /** @public */ HarnessError,
  /** @public */ isHarnessError,
  /** @public */ isTurnError,
  TurnBeginError,
  turnBeginCodes,
  turnEndingOf,
} from "@xandreed/core"
export type { TurnError } from "@xandreed/core"

// what the process still has in flight, for a `/ping` or a drain, and a shutdown within a deadline
export {
  /** @public */ awaitIdle,
  /** @public */ DEFAULT_SHUTDOWN_DEADLINE,
  /** @public */ isShutdownRefusal,
  /** @public */ processActivity,
  /** @public */ shutdownGracefully,
  /** @public */ TurnShutdown,
} from "@xandreed/core"
export type { ShutdownOptions, /** @public */ ShutdownReport } from "@xandreed/core"
