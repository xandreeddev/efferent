import { Schema } from "effect"
import { PluginName } from "./ids.entity.js"

/**
 * What a plugin declares of itself, as plain data: its name, the keys of
 * the contracts it needs, and the key of the contract it provides, when it
 * provides one. A key is the string a contract's `Context.Service` is
 * declared with.
 *
 * @public
 */
export const PluginNode = Schema.Struct({
  name: PluginName,
  requires: Schema.Array(Schema.String),
  provides: Schema.optionalKey(Schema.String),
})
export type PluginNode = typeof PluginNode.Type

/**
 * What a set of plugins is planned against: the plugins, in the order they
 * are listed; the keys of the contracts that are there before any of them
 * is built (`given`); and the keys of the contracts that exist only after
 * all of them are built (`later`), which none of them may need.
 *
 * @public
 */
export const PluginStage = Schema.Struct({
  plugins: Schema.Array(PluginNode),
  given: Schema.Array(Schema.String),
  later: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type PluginStage = typeof PluginStage.Type

/**
 * A set of plugins was refused before any of them was built. `plugin` and
 * `contract` name the plugin and the key the refusal is about:
 *
 * - `MissingProvider`: `plugin` needs `contract`, and nothing provides it.
 * - `DuplicateProvider`: `plugin` provides `contract`, which another
 *   plugin, or the wiring itself, provides already.
 * - `Cycle`: `plugin` needs `contract`, whose provider needs, directly or
 *   through others, what `plugin` provides.
 * - `LaterContract`: `plugin` needs `contract`, which exists only after
 *   `plugin` is built.
 * - `ListedTwice`: `plugin` is in the list twice, the same plugin and not
 *   two of a kind. `contract` is the one it provides, or empty when it
 *   provides none.
 *
 * @public
 */
export class PluginRefused extends Schema.TaggedError<PluginRefused>()("PluginRefused", {
  reason: Schema.Literals(["MissingProvider", "DuplicateProvider", "Cycle", "LaterContract", "ListedTwice"]),
  plugin: PluginName,
  contract: Schema.String,
  message: Schema.String,
}) {}
