import { Schema } from "effect"
import type { Plugin } from "./plugin.entity.js"

export const PluginEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  use: Schema.NonEmptyString,
  enabled: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type PluginEntry = typeof PluginEntry.Type

export const Profile = Schema.Struct({
  plugins: Schema.optional(Schema.Array(PluginEntry)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  system: Schema.optional(Schema.String),
})
export type Profile = typeof Profile.Type

export const HarnessConfig = Schema.Struct({
  version: Schema.Literal(1),
  profile: Schema.optional(Schema.String),
  plugins: Schema.optional(Schema.Array(PluginEntry)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  profiles: Schema.optional(Schema.Record(Schema.String, Profile)),
  system: Schema.optional(Schema.String),
})
export type HarnessConfig = typeof HarnessConfig.Type

export interface AgentDefinition {
  readonly id: string
  readonly config: HarnessConfig
  readonly plugins: ReadonlyArray<Plugin>
}
