import { Schema } from "effect"
import type { Context, Effect, Scope } from "effect"

export const PLUGIN_API_VERSION = 2
/** Version 1 plugins (no contributions, no optional services) still load. */
export const SUPPORTED_PLUGIN_API_VERSIONS: ReadonlyArray<number> = [1, 2]

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  code: Schema.String,
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
}) {}

/** The runtime consumes this erased boundary; authors use definePlugin. */
export interface Plugin {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly scope: "runtime" | "session"
  readonly requires: ReadonlyArray<string>
  readonly provides: ReadonlyArray<string>
  /** Multi-provider keys: every contributor's array is concatenated in graph order. */
  readonly contributes: ReadonlyArray<string>
  /** Used when present (ordering and dependencies), never required. */
  readonly optional: ReadonlyArray<string>
  readonly schema: Schema.Schema.AnyNoContext
  readonly defaults: Readonly<Record<string, unknown>>
  readonly build: (
    options: unknown,
    services: Context.Context<never>,
  ) => Effect.Effect<Context.Context<never>, HarnessError, Scope.Scope>
}
