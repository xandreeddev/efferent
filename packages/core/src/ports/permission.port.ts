import { Context } from "effect"
import type { Effect } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"

/** The permissions a run holds; skills and tools needing others are never activated. */
export class PermissionGrants extends Context.Service<PermissionGrants, {
  readonly grants: Effect.Effect<ReadonlySet<string>, HarnessError>
}>()("efferent/PermissionGrants") {}
