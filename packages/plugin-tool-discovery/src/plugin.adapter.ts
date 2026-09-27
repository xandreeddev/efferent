import { Effect, Layer, Option, Schema } from "effect"
import {
  ActionPolicy,
  CapabilityGrants,
  Contributions,
  defineContributions,
  definePlugin,
  IntentMatcher,
  ToolRegistry,
} from "@xandreed/core"
import { catalogText, makeRegistry } from "./registry.adapter.js"

const Config = Schema.Struct({
  /** Granted permissions when no CapabilityGrants service is present. */
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
 * contributions; this plugin registers them, keeps the grow-only active set
 * in memory, runs the optional pre-turn matcher, serves load_skill (tier 2)
 * and references (tier 3), and checks every call centrally: active set,
 * grants, action policy, budgets and concurrency lanes.
 */
export const toolDiscoveryPlugin = definePlugin({
  id: "@xandreed/plugin-tool-discovery", version: "0.5.0-next.0",
  config: Config, defaults,
  requires: [Contributions],
  optional: [IntentMatcher, CapabilityGrants, ActionPolicy],
  provides: [ToolRegistry],
  contributes: [Contributions],
  layer: (config) => Layer.unwrapEffect(Effect.gen(function* () {
    const contributions = yield* Contributions
    const matcher = yield* Effect.serviceOption(IntentMatcher)
    const grants = yield* Effect.serviceOption(CapabilityGrants)
    const policy = yield* Effect.serviceOption(ActionPolicy)
    const registry = yield* makeRegistry(config, contributions, {
      matcher,
      grants: Option.map(grants, (service) => service.grants),
      authorize: Option.map(policy, (service) => service.authorize),
    })
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
