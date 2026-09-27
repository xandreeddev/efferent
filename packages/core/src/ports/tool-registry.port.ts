import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Tool, Toolkit } from "@effect/ai"
import type { CapabilityCatalog } from "../harness/capability.entity.js"
import type { SkillDefinition } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { ActivationSource } from "../memory/memory-log.entity.js"
import type { MemorySession, ToolViews } from "./memory.port.js"

/** The tools of one run: the full set is fixed at run start; the active set only grows. */
export interface RunTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlers: Context.Context<never>
  /** Active tool names in activation order. */
  readonly active: Effect.Effect<ReadonlyArray<string>>
  readonly activate: (skills: ReadonlyArray<string>, source: ActivationSource) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** Pre-turn selection: always-on skills plus the matcher's choice, recorded once per turn. */
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
