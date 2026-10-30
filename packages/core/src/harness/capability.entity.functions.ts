import type { Tool } from "effect/ai"
import { Context, Effect, Option } from "effect"
import { strictJsonSchema, toolParametersSchema } from "../internal/tool-schema.entity.functions.js"
import type { Capability, PromptContext, PromptSection, RegisteredTool, ToolDefinition, ToolViewInput } from "../ports/capability.port.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { CapabilityId, CapabilityToolId, SkillId, SkillReferenceId } from "./capability.entity.js"
import type {
  CapabilityCatalog,
  CapabilitySelection,
  PromptTier,
  ResolvedCapabilities,
  SkillDefinition,
  ToolAnnotations,
} from "./capability.entity.js"
import { HarnessError } from "./plugin.entity.js"
import { provideDeclared } from "./plugin.entity.functions.js"
import type { ServiceKeys } from "./plugin.entity.functions.js"

export const defaultAnnotations: ToolAnnotations = {
  readOnly: false, pollable: false, pinned: false, permissions: [], maxCallsPerRun: Option.none(), labels: {}, stage: Option.none(),
}

/** The declared keys that must be there: every service but the References, which have defaults. */
const checkedKeys = (requires: ServiceKeys): ReadonlyArray<string> =>
  requires.filter((key) => !Context.isReference(key)).map((key) => key.key)

/**
 * Author a tool with its handler, model view and annotations; the registry
 * erases it. The handler may read only the services `requires` lists (a
 * Reference needs no entry): one that reads another does not compile. It
 * gets them where it runs, through `provideDeclared`, which fails the call
 * with `requires.missing` when one is not there; a registry checks the same
 * keys (`RegisteredTool.requires`) when it opens a run's tools, so a run
 * lacking one fails to open instead.
 */
export const defineTool = <T extends Tool.Any, const Req extends ServiceKeys = readonly []>(definition: {
  readonly tool: T
  readonly requires?: Req
  readonly handler: ToolDefinition<T, Context.Service.Identifier<Req[number]>>["handler"]
  readonly view?: ToolViewInput<Tool.Success<T>, Tool.Parameters<T>>
  readonly annotations?: Partial<ToolAnnotations>
}): RegisteredTool => {
  const requires = definition.requires ?? ([] as const)
  const declared = provideDeclared(definition.tool.name, requires)
  return {
    tool: definition.tool,
    requires: checkedKeys(requires),
    // The toolkit decodes the params against the tool's own schema before it calls the handler.
    handler: (params) => declared(definition.handler(params as Tool.Parameters<T>)),
    view: Option.map(Option.fromNullishOr(definition.view), (view) => ({
      version: view.version,
      render: view.render,
      compact: Option.fromNullishOr(view.compact),
      subjects: view.subjects ?? (() => []),
      artifacts: view.artifacts ?? (() => []),
      digest: Option.fromNullishOr(view.digest),
      media: Option.fromNullishOr(view.media),
    })) as RegisteredTool["view"],
    annotations: { ...defaultAnnotations, ...definition.annotations },
  }
}

/**
 * Author a prompt section that reads services. `render` may read only the
 * services `requires` lists (a Reference needs no entry): one that reads
 * another does not compile. It gets them where the turn renders it (the
 * run's services), through `provideDeclared`, which fails the render with
 * `requires.missing`, naming the section and each missing service, when one
 * is not there; the declared keys, References aside, are kept as
 * `PromptSection.requires`.
 */
export const definePromptSection = <const Req extends ServiceKeys = readonly []>(section: {
  readonly id: string
  readonly version: string
  readonly tier: PromptTier
  readonly order: number
  readonly requires?: Req
  readonly render: (context: PromptContext) => Effect.Effect<Option.Option<string>, HarnessError, Context.Service.Identifier<Req[number]>>
}): PromptSection => {
  const requires = section.requires ?? ([] as const)
  const declared = provideDeclared(section.id, requires)
  return {
    id: section.id,
    version: section.version,
    tier: section.tier,
    order: section.order,
    requires: checkedKeys(requires),
    render: (context) => declared(section.render(context)),
  }
}

/**
 * A skill, as `defineSkill` takes it: its ids as strings, which it brands
 * (`SkillId`, `SkillReferenceId`; one that is empty or not trimmed throws).
 * An always-on skill is active from every turn's first step and is never
 * loaded, so nothing shows the model instructions on it: it takes none
 * (`instructions` does not compile with `always: true`). Give the model
 * what such a skill's tools need in their descriptions or in a prompt
 * section.
 *
 * @public
 */
export type SkillInput = {
  readonly id: string
  readonly summary: string
  readonly tools: ReadonlyArray<string>
  readonly version?: string
  readonly permissions?: ReadonlyArray<string>
  readonly references?: ReadonlyArray<{ readonly id: string; readonly title: string; readonly text: string }>
} & (
  | { readonly always: true; readonly instructions?: never }
  | { readonly always?: false; readonly instructions?: string }
)

export const defineSkill = (skill: SkillInput): SkillDefinition => ({
  id: SkillId.make(skill.id),
  version: skill.version ?? "1",
  summary: skill.summary,
  instructions: skill.instructions ?? "",
  tools: skill.tools,
  always: skill.always ?? false,
  permissions: skill.permissions ?? [],
  references: (skill.references ?? []).map((reference) => ({ ...reference, id: SkillReferenceId.make(reference.id) })),
})

/** A capability from its parts; its id is a string, which it brands (`CapabilityId`). */
export const defineCapability = (capability: {
  readonly id: string
  readonly version: string
  readonly tools?: Capability["tools"]
  readonly skills?: Capability["skills"]
  readonly promptSections?: Capability["promptSections"]
}): Capability => ({
  id: CapabilityId.make(capability.id),
  version: capability.version,
  tools: capability.tools ?? [],
  skills: capability.skills ?? [],
  promptSections: capability.promptSections ?? [],
})

/**
 * The resolver's catalogue: skills are recipes, registered tools are
 * capability tools, each with the JSON Schema of its parameters and of its
 * result as JSON (`storedJson`). The generator writes JSON only, so a
 * schema JSON cannot hold is a defect.
 */
export const catalogOf = (version: string, capabilities: ReadonlyArray<Capability>): Effect.Effect<CapabilityCatalog> =>
  Effect.forEach(capabilities.flatMap((capability) => capability.tools), (registered) =>
    Effect.all({
      inputSchema: storedJson(toolParametersSchema(registered.tool)),
      outputSchema: storedJson(strictJsonSchema(registered.tool.successSchema)),
    }, { concurrency: 1 }).pipe(Effect.map(({ inputSchema, outputSchema }) => ({
      id: CapabilityToolId.make(registered.tool.name),
      version: "1",
      description: registered.tool.description ?? registered.tool.name,
      returns: "tool result",
      permissions: registered.annotations.permissions,
      inputSchema,
      outputSchema,
    }))), { concurrency: 1 }).pipe(
    Effect.orDie,
    Effect.map((tools) => ({
      version,
      recipes: capabilities.flatMap((capability) => capability.skills).map((skill) => ({
        id: skill.id, version: skill.version, instructions: skill.instructions.length > 0 ? skill.instructions : skill.summary, tools: skill.tools,
      })),
      tools,
    })),
  )

/** Probabilistic intent never authorizes a capability. Expansions use this same
 * deterministic resolver against the run-pinned catalog and current grants. */
export const resolveCapabilities = Effect.fnUntraced(function* (catalog: CapabilityCatalog, requested: CapabilitySelection, permissions: ReadonlySet<string>): Effect.fn.Return<ResolvedCapabilities, HarnessError> {
  const recipeIds = new Set(requested.recipes)
  const recipes = catalog.recipes.filter((recipe) => recipeIds.has(recipe.id))
  const toolIds = new Set([...requested.tools, ...recipes.flatMap((recipe) => recipe.tools)])
  const tools = catalog.tools.filter((tool) => toolIds.has(tool.id))
  const duplicate = new Set(catalog.recipes.map((recipe) => recipe.id)).size !== catalog.recipes.length || new Set(catalog.tools.map((tool) => tool.id)).size !== catalog.tools.length
  if (duplicate || recipes.length !== recipeIds.size || tools.length !== toolIds.size) return yield* Effect.fail(new HarnessError({ code: "capability.catalog", message: "Selection references an ambiguous or missing capability" }))
  const lacking = tools.flatMap((tool) => {
    const missing = tool.permissions.filter((permission) => !permissions.has(permission))
    return missing.length === 0 ? [] : [`${tool.id} needs ${missing.join(", ")}`]
  })
  if (lacking.length > 0) {
    return yield* Effect.fail(new HarnessError({ code: "capability.forbidden", message: `Selection requires permissions this run was not granted (${lacking.join("; ")}); it cannot be loaded in this run` }))
  }
  return { catalogVersion: catalog.version, recipes, tools }
})
