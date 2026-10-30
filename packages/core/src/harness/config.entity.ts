import { Schema } from "effect"

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
 * A plugin graph's configuration: the plugin instances, the bindings that
 * pick the instance providing a service more than one provides, and the
 * system prompt.
 * Profiles are a host's own: the host folds the selected one into these
 * fields before the graph is resolved, and `resolveGraph` refuses a config
 * that still carries `profile` or `profiles` (`config.profile`) rather than
 * ignore them.
 */
export const HarnessConfig = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.optional(Schema.Array(PluginEntry)),
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  system: Schema.optional(Schema.String),
})
export type HarnessConfig = typeof HarnessConfig.Type
