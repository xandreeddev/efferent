import type { Tool } from "effect/ai"
import { Effect, Option } from "effect"
import { strictJsonSchema, toolParametersSchema } from "../loop/toolSchema.js"
import type { Capability, RegisteredTool, ToolDefinition, ToolViewInput } from "../ports/capability.port.js"
import type {
  CapabilityCatalog,
  CapabilitySelection,
  ResolvedCapabilities,
  SkillDefinition,
  ToolAnnotations,
} from "./capability.entity.js"
import { HarnessError } from "./plugin.entity.js"

export const defaultAnnotations: ToolAnnotations = {
  readOnly: false, pollable: false, pinned: false, permissions: [], maxCallsPerRun: Option.none(), labels: {}, stage: Option.none(),
}

/** Author a tool with its handler, model view and annotations; the registry erases it. */
export const defineTool = <T extends Tool.Any, R>(definition: {
  readonly tool: T
  readonly handler: ToolDefinition<T, R>["handler"]
  readonly view?: ToolViewInput<Tool.Success<T>, Tool.Parameters<T>>
  readonly annotations?: Partial<ToolAnnotations>
}): RegisteredTool => ({
  tool: definition.tool,
  handler: definition.handler as (params: unknown) => Effect.Effect<unknown, unknown, unknown>,
  view: Option.map(Option.fromNullishOr(definition.view), (view) => ({
    version: view.version,
    render: view.render,
    compact: Option.fromNullishOr(view.compact),
    subjects: view.subjects ?? (() => []),
    artifacts: view.artifacts ?? (() => []),
    digest: Option.fromNullishOr(view.digest),
  })) as RegisteredTool["view"],
  annotations: { ...defaultAnnotations, ...definition.annotations },
})

export const defineSkill = (skill: {
  readonly id: string
  readonly summary: string
  readonly instructions?: string
  readonly tools: ReadonlyArray<string>
  readonly version?: string
  readonly always?: boolean
  readonly permissions?: ReadonlyArray<string>
  readonly references?: SkillDefinition["references"]
}): SkillDefinition => ({
  id: skill.id,
  version: skill.version ?? "1",
  summary: skill.summary,
  instructions: skill.instructions ?? "",
  tools: skill.tools,
  always: skill.always ?? false,
  permissions: skill.permissions ?? [],
  references: skill.references ?? [],
})

export const defineCapability = (capability: {
  readonly id: string
  readonly version: string
  readonly tools?: Capability["tools"]
  readonly skills?: Capability["skills"]
  readonly promptSections?: Capability["promptSections"]
}): Capability => ({
  id: capability.id,
  version: capability.version,
  tools: capability.tools ?? [],
  skills: capability.skills ?? [],
  promptSections: capability.promptSections ?? [],
})

/** The resolver's catalogue: skills are recipes, registered tools are capability tools. */
export const catalogOf = (version: string, capabilities: ReadonlyArray<Capability>): CapabilityCatalog => ({
  version,
  recipes: capabilities.flatMap((capability) => capability.skills).map((skill) => ({
    id: skill.id, version: skill.version, instructions: skill.instructions.length > 0 ? skill.instructions : skill.summary, tools: skill.tools,
  })),
  tools: capabilities.flatMap((capability) => capability.tools).map((registered) => ({
    id: registered.tool.name,
    version: "1",
    description: registered.tool.description ?? registered.tool.name,
    returns: "tool result",
    permissions: registered.annotations.permissions,
    inputSchema: { ...toolParametersSchema(registered.tool) },
    outputSchema: { ...strictJsonSchema(registered.tool.successSchema) },
  })),
})

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
