import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import type { DecisionRecord } from "../decision-record.entity.js"
import type { CapabilityCatalog } from "../harness/capability.entity.js"
import type { SkillDefinition } from "../harness/capability.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { ActivationSource } from "../memory/memory-log.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { MemorySession, ToolViews } from "./memory.port.js"
import type { RunContext } from "./run-context.port.js"

/**
 * What the pre-turn matcher chose, before anything is recorded: `match`
 * writes nothing, so it can run beside other pre-turn work (and be dropped
 * when the turn ends early); `apply` activates, records and publishes it.
 */
export interface SkillMatch {
  readonly userMessage: UserMessage
  /** Skills the matcher chose that are not loaded yet. */
  readonly skills: ReadonlyArray<string>
  readonly probabilities: Option.Option<Readonly<Record<string, number>>>
  /** The decision as matched; None without a matcher. `apply` records it with its final validation. */
  readonly record: Option.Option<DecisionRecord>
}

/**
 * The handlers of a run's tools, as a context: what `RunTools.toolkit`
 * needs to handle a call. Provided to the toolkit, it meets the toolkit's
 * requirement as it is, without a cast. A context of typed handlers
 * (`Toolkit.make(A, B).toHandlers(...)`) is one.
 */
export type ToolHandlers = Tool.HandlersFor<Record<string, Tool.Any>>

/** The tools of one run: the full set is fixed at run start; the active set only grows. */
export interface RunTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlers: Context.Context<ToolHandlers>
  /** Active tool names in activation order. */
  readonly active: Effect.Effect<ReadonlyArray<string>>
  /**
   * Activate skills in one step, so activations running at once each keep the
   * other's tools; returns the active tools after it. A refusal fails with
   * `skills.unknown` or `capability.forbidden`; any other failure is the
   * store's, and activates nothing.
   */
  readonly activate: (skills: ReadonlyArray<string>, source: ActivationSource) => Effect.Effect<ReadonlyArray<string>, TurnError>
  /** Ask the matcher, without writing anything. */
  readonly match: (userMessage: UserMessage) => Effect.Effect<SkillMatch, HarnessError>
  /** Always-on skills plus a match: activated, recorded as a decision, seeded as a load_skill exchange. */
  readonly apply: (match: SkillMatch) => Effect.Effect<ReadonlyArray<string>, TurnError>
  /** `match` then `apply`. */
  readonly select: (userMessage: UserMessage) => Effect.Effect<ReadonlyArray<string>, TurnError>
  readonly views: ToolViews
  readonly pollable: ReadonlyArray<string>
  readonly skills: ReadonlyArray<SkillDefinition>
}

export class ToolRegistry extends Context.Service<ToolRegistry, {
  readonly catalog: CapabilityCatalog
  /**
   * Open the tools of one run. The handlers run with the services of where
   * it is opened (host services, run layers, RunContext), captured at open;
   * an IntentMatcher, ActionPolicy and PermissionGrants there are used.
   */
  readonly open: (session: MemorySession) => Effect.Effect<RunTools, TurnError, RunContext | Scope.Scope>
}>()("efferent/ToolRegistry") {}
