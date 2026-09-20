import { Schema } from "effect"
import type { Context, Effect, Scope } from "effect"

export const PLUGIN_API_VERSION = 1

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
  readonly schema: Schema.Schema.AnyNoContext
  readonly defaults: Readonly<Record<string, unknown>>
  readonly build: (
    options: unknown,
    services: Context.Context<never>,
  ) => Effect.Effect<Context.Context<never>, HarnessError, Scope.Scope>
}
