import { Result } from "effect"
import { PluginRefused } from "./plugin.entity.js"
import type { PluginNode, PluginStage } from "./plugin.entity.js"

const refused = (reason: PluginRefused["reason"], plugin: PluginNode, contract: string, message: string) =>
  Result.fail(new PluginRefused({ reason, plugin: plugin.name, contract, message }))

/**
 * The order to build a stage's plugins in, or the refusal of the stage,
 * decided from what the plugins declare and before any of them is built.
 *
 * Refused: a plugin that is in the list twice, the very same one
 * (`ListedTwice`); a plugin that provides a contract another plugin listed
 * before it, or the wiring, provides already (`DuplicateProvider`); then, plugin
 * by plugin in the listed order and contract by contract as declared, the
 * first contract that nothing provides, which is `LaterContract` when it
 * exists only later and `MissingProvider` otherwise; then plugins that
 * need each other in a circle, one that needs what it provides itself
 * included (`Cycle`).
 *
 * The order: every plugin stays at its listed place, and the providers of
 * what it needs that are listed after it are built just before it, in the
 * order they are listed. So a plugin is always built after its providers,
 * plugins that are not moved for one another keep the order they were
 * listed in, and the order a plugin writes its `requires` in changes
 * nothing. No plugin is added: a missing provider is a refusal that says
 * what to add.
 *
 * @public
 */
export const planPlugins = <P extends PluginNode>(stage: Omit<PluginStage, "plugins"> & { readonly plugins: ReadonlyArray<P> }): Result.Result<ReadonlyArray<P>, PluginRefused> => {
  const given = new Set(stage.given)
  const later = new Set(stage.later ?? [])
  const again = stage.plugins.find((plugin, index) => stage.plugins.indexOf(plugin) !== index)
  if (again !== undefined) return refused("ListedTwice", again, again.provides ?? "", `plugin ${again.name} is listed twice: list it once`)
  const providers = new Map<string, P>()
  for (const plugin of stage.plugins) {
    if (plugin.provides === undefined) continue
    const other = providers.get(plugin.provides)
    if (other !== undefined) return refused("DuplicateProvider", plugin, plugin.provides, `plugins ${other.name} and ${plugin.name} both provide ${plugin.provides}: list one of them`)
    if (given.has(plugin.provides)) return refused("DuplicateProvider", plugin, plugin.provides, `plugin ${plugin.name} provides ${plugin.provides}, which is provided already: it is not a plugin's to provide here`)
    providers.set(plugin.provides, plugin)
  }
  for (const plugin of stage.plugins) {
    for (const contract of plugin.requires) {
      if (given.has(contract) || providers.has(contract)) continue
      if (later.has(contract)) return refused("LaterContract", plugin, contract, `plugin ${plugin.name} requires ${contract}, which exists only after ${plugin.name} is built`)
      return refused("MissingProvider", plugin, contract, `plugin ${plugin.name} requires ${contract}, which no plugin provides: add a plugin that provides it`)
    }
  }

  const listedAt = new Map(stage.plugins.map((plugin, index) => [plugin, index] as const))
  /** A plugin's providers among the plugins, with the contract each is needed for, in the order they are listed. */
  const providersOf = (plugin: P) => plugin.requires
    .flatMap((contract) => {
      const provider = providers.get(contract)
      return provider === undefined ? [] : [{ contract, provider }]
    })
    .sort((one, other) => (listedAt.get(one.provider) ?? 0) - (listedAt.get(other.provider) ?? 0))

  const order: Array<P> = []
  const placed = new Set<P>()
  /** Place a plugin after the providers of what it needs; `path` is the plugins being placed for one another. */
  const place = (plugin: P, path: ReadonlyArray<P>): Result.Result<void, PluginRefused> => {
    if (placed.has(plugin)) return Result.succeed(undefined)
    for (const { contract, provider } of providersOf(plugin)) {
      if (provider === plugin || path.includes(provider)) {
        const circle = [...path.slice(path.indexOf(provider)), plugin, provider].map((each) => each.name)
        return refused("Cycle", plugin, contract, `plugin ${plugin.name} requires ${contract}, whose provider needs ${plugin.name} in turn: ${(provider === plugin ? [plugin.name, plugin.name] : circle).join(" → ")}`)
      }
      const before = place(provider, [...path, plugin])
      if (Result.isFailure(before)) return before
    }
    placed.add(plugin)
    order.push(plugin)
    return Result.succeed(undefined)
  }
  for (const plugin of stage.plugins) {
    const result = place(plugin, [])
    if (Result.isFailure(result)) return Result.fail(result.failure)
  }
  return Result.succeed(order)
}
