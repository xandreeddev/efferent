import { Context } from "effect"
import type { Effect } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"

export class ActionPolicy extends Context.Service<ActionPolicy, {
  readonly authorize: (tool: string, input: unknown) => Effect.Effect<void, HarnessError>
}>()("efferent/ActionPolicy") {}

export class SessionEnvironment extends Context.Service<SessionEnvironment, {
  readonly workspace: string
}>()("efferent/SessionEnvironment") {}
