import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { AgentMessage } from "../domain/message.entity.js"
import type { CapabilityCatalog } from "../harness/capability.entity.js"
import type { SkillDefinition } from "../harness/contribution.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"

export class Capabilities extends Context.Tag("efferent/Capabilities")<Capabilities, {
  readonly catalog: CapabilityCatalog
}>() {}

export interface IntentMatch {
  readonly skills: ReadonlyArray<string>
  readonly probabilities: Option.Option<Readonly<Record<string, number>>>
  /** The matcher declined to choose; the turn runs on always-on skills. */
  readonly abstained: boolean
}

/** Pre-turn skill selection. Probabilistic intent never authorizes: the registry resolves grants. */
export class IntentMatcher extends Context.Tag("efferent/IntentMatcher")<IntentMatcher, {
  readonly id: string
  readonly version: string
  readonly match: (input: {
    readonly userMessage: UserMessage
    readonly skills: ReadonlyArray<SkillDefinition>
    readonly active: ReadonlyArray<string>
    /** A reference transcript: user messages and replies only. */
    readonly history: ReadonlyArray<AgentMessage>
  }) => Effect.Effect<IntentMatch, HarnessError>
}>() {}

/** The permissions a run holds; skills and tools needing others are never activated. */
export class CapabilityGrants extends Context.Tag("efferent/CapabilityGrants")<CapabilityGrants, {
  readonly grants: Effect.Effect<ReadonlySet<string>, HarnessError>
}>() {}
