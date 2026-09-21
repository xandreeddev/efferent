import { Effect } from "effect"
import type { CapabilityCatalog, CapabilitySelection, ResolvedCapabilities } from "./capability.entity.js"
import { HarnessError } from "./plugin.entity.js"

/** Probabilistic intent never authorizes a capability. Expansions use this same
 * deterministic resolver against the run-pinned catalog and current grants. */
export const resolveCapabilities = (catalog: CapabilityCatalog, requested: CapabilitySelection, permissions: ReadonlySet<string>): Effect.Effect<ResolvedCapabilities, HarnessError> => Effect.gen(function* () {
  const recipeIds = new Set(requested.recipes)
  const recipes = catalog.recipes.filter((recipe) => recipeIds.has(recipe.id))
  const toolIds = new Set([...requested.tools, ...recipes.flatMap((recipe) => recipe.tools)])
  const tools = catalog.tools.filter((tool) => toolIds.has(tool.id))
  const duplicate = new Set(catalog.recipes.map((recipe) => recipe.id)).size !== catalog.recipes.length || new Set(catalog.tools.map((tool) => tool.id)).size !== catalog.tools.length
  if (duplicate || recipes.length !== recipeIds.size || tools.length !== toolIds.size) return yield* Effect.fail(new HarnessError({ code: "capability.catalog", message: "Selection references an ambiguous or missing capability" }))
  if (tools.some((tool) => tool.permissions.some((permission) => !permissions.has(permission)))) return yield* Effect.fail(new HarnessError({ code: "capability.forbidden", message: "Selection requires unavailable permissions" }))
  return { catalogVersion: catalog.version, recipes, tools }
})
