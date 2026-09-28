import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { Tool, Toolkit } from "@effect/ai"
import type { DecisionRecord } from "../decision-record.entity.js"
import type { CapabilityCatalog } from "../harness/capability.entity.js"
import type { SkillDefinition } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { ActivationSource } from "../memory/memory-log.entity.js"
import type { MemorySession, ToolViews } from "./memory.port.js"

/**
 * What the pre-turn matcher chose, before anything is recorded: `match`
 * writes nothing, so it can run beside other pre-turn work (and be dropped
 * when the turn ends early); `apply` activates, records and publishes it.
 */
export interface SkillMatch {
  readonly message: string
  /** Skills the matcher chose that are not loaded yet. */
  readonly skills: ReadonlyArray<string>
  readonly probabilities: Option.Option<Readonly<Record<string, number>>>
  /** The decision as matched; None without a matcher. `apply` records it with its final validation. */
  readonly record: Option.Option<DecisionRecord>
}

/** The tools of one run: the full set is fixed at run start; the active set only grows. */
export interface RunTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlers: Context.Context<never>
  /** Active tool names in activation order. */
  readonly active: Effect.Effect<ReadonlyArray<string>>
  readonly activate: (skills: ReadonlyArray<string>, source: ActivationSource) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** Ask the matcher, without writing anything. */
  readonly match: (message: string) => Effect.Effect<SkillMatch, HarnessError>
  /** Always-on skills plus a match: activated, recorded as a decision, seeded as a load_skill exchange. */
  readonly apply: (match: SkillMatch) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** `match` then `apply`. */
  readonly select: (message: string) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly views: ToolViews
  readonly pollable: ReadonlyArray<string>
  readonly skills: ReadonlyArray<SkillDefinition>
}

export class ToolRegistry extends Context.Tag("efferent/ToolRegistry")<ToolRegistry, {
  readonly catalog: CapabilityCatalog
  /** `services` is the full per-run context the handlers run with (host services, run layers, RunContext). */
  readonly open: (session: MemorySession, services: Context.Context<never>) => Effect.Effect<RunTools, HarnessError, Scope.Scope>
}>() {}
