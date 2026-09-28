import { Effect, Layer, Schema } from "effect"
import { Contributions, defineContributions, definePlugin, ToolRegistry } from "@xandreed/core"
import { catalogText, makeRegistry } from "./registry.adapter.js"

const Config = Schema.Struct({
  /** Granted permissions when the turn's services carry no CapabilityGrants. */
  grants: Schema.Array(Schema.String),
  /** Expose the skill catalogue, load_skill and read_skill_reference. */
  loadSkill: Schema.Boolean,
  maxCallsPerRun: Schema.Int.pipe(Schema.between(1, 1000)),
  maxSkillLoadsPerRun: Schema.Int.pipe(Schema.between(0, 100)),
  readConcurrency: Schema.Int.pipe(Schema.between(1, 32)),
  matcherTimeoutMs: Schema.Int.pipe(Schema.between(50, 60_000)),
  catalogVersion: Schema.NonEmptyString,
  /** Order of the catalogue section within the system prompt. */
  catalogOrder: Schema.Int,
})
type Config = typeof Config.Type
const defaults: Config = {
  grants: [], loadSkill: true, maxCallsPerRun: 64, maxSkillLoadsPerRun: 4, readConcurrency: 4,
  matcherTimeoutMs: 3_000, catalogVersion: "1", catalogOrder: 900,
}

/**
 * Tool registry and discovery. Hosts DEFINE tools and skills as
 * contributions; this plugin registers them once, keeps the grow-only active
 * set in memory, runs the optional pre-turn matcher, serves load_skill
 * (tier 2) and references (tier 3), checks every call centrally (active set,
 * grants, action policy, budgets and concurrency lanes) and publishes
 * `tool.started`, `tool.completed`, `skills.activated` and
 * `decision.recorded` on the turn's bus. The matcher, grants and action
 * policy are read from each turn's services.
 */
export const toolDiscoveryPlugin = definePlugin({
  id: "@xandreed/plugin-tool-discovery", version: "0.6.0-next.0", scope: "runtime",
  config: Config, defaults,
  requires: [Contributions],
  provides: [ToolRegistry],
  contributes: [Contributions],
  layer: (config) => Layer.unwrapEffect(Effect.gen(function* () {
    const contributions = yield* Contributions
    const registry = yield* makeRegistry(config, contributions)
    const catalogue = defineContributions({
      id: "@xandreed/plugin-tool-discovery/catalogue",
      version: "1",
      sections: config.loadSkill ? [{
        id: "tool-discovery.catalogue", version: "1", tier: "static", order: config.catalogOrder,
        render: () => Effect.succeed(catalogText(registry.skills)),
      }] : [],
    })
    return Layer.mergeAll(
      Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: registry.catalog, open: registry.open })),
      Layer.succeed(Contributions, [catalogue]),
    )
  })),
})
export default toolDiscoveryPlugin
