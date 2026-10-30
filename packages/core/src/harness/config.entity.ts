import { Schema } from "effect"
import type { Plugin } from "./plugin.entity.js"

/** Names one instance of a plugin in a graph (a binding names its provider by it); by default the plugin's own id. */
export const PluginInstanceId = Schema.NonEmptyString.pipe(Schema.brand("PluginInstanceId"))
export type PluginInstanceId = typeof PluginInstanceId.Type

export const PluginEntry = Schema.Struct({
  id: PluginInstanceId,
  use: Schema.NonEmptyString,
  enabled: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type PluginEntry = typeof PluginEntry.Type

/**
 * @deprecated A config's `profiles` entry, which `resolveGraph` refuses
 * (`config.profile`). Removed in the next minor release.
 */
export const Profile = Schema.Struct({
  plugins: Schema.optional(Schema.Array(PluginEntry)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  system: Schema.optional(Schema.String),
})
/**
 * @deprecated A config's `profiles` entry, which `resolveGraph` refuses
 * (`config.profile`). Removed in the next minor release.
 */
export type Profile = typeof Profile.Type

/**
 * A plugin graph's configuration. `profile` and `profiles` describe a
 * selection the host makes before the graph is resolved (the selected
 * profile's plugins, bindings and system folded into the config's own):
 * `resolveGraph` refuses a config that still carries them (`config.profile`)
 * rather than ignore them.
 */
export const HarnessConfig = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * @deprecated `resolveGraph` refuses a config that carries it
   * (`config.profile`): fold the selected profile into the config before
   * resolving it. Removed in the next minor release.
   */
  profile: Schema.optional(Schema.String),
  plugins: Schema.optional(Schema.Array(PluginEntry)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * @deprecated `resolveGraph` refuses a config that carries it
   * (`config.profile`): fold the selected profile into the config before
   * resolving it. Removed in the next minor release.
   */
  profiles: Schema.optional(Schema.Record(Schema.String, Profile)),
  system: Schema.optional(Schema.String),
})
export type HarnessConfig = typeof HarnessConfig.Type

/**
 * @deprecated What `defineAgent` takes; compose an agent with `Agent.define`
 * (`@xandreed/sdk`). Removed in the next minor release.
 */
export interface AgentDefinition {
  readonly id: string
  readonly config: HarnessConfig
  readonly plugins: ReadonlyArray<Plugin>
}
