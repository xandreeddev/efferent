import type { Tool } from "@effect/ai"
import { JSONSchema, Option } from "effect"
import type { Effect } from "effect"
import type { Contribution, RegisteredTool, ToolDefinition, ToolViewInput } from "../ports/contribution.port.js"
import type { CapabilityCatalog } from "./capability.entity.js"
import type { SkillDefinition, ToolAnnotations } from "./contribution.entity.js"

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
  view: Option.map(Option.fromNullable(definition.view), (view) => ({
    version: view.version,
    render: view.render,
    compact: Option.fromNullable(view.compact),
    subjects: view.subjects ?? (() => []),
    artifacts: view.artifacts ?? (() => []),
    digest: Option.fromNullable(view.digest),
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

export const defineContributions = (contribution: {
  readonly id: string
  readonly version: string
  readonly tools?: Contribution["tools"]
  readonly skills?: Contribution["skills"]
  readonly sections?: Contribution["sections"]
}): Contribution => ({
  id: contribution.id,
  version: contribution.version,
  tools: contribution.tools ?? [],
  skills: contribution.skills ?? [],
  sections: contribution.sections ?? [],
})

/** The resolver's catalogue: skills are recipes, registered tools are capability tools. */
export const catalogOf = (version: string, contributions: ReadonlyArray<Contribution>): CapabilityCatalog => ({
  version,
  recipes: contributions.flatMap((contribution) => contribution.skills).map((skill) => ({
    id: skill.id, version: skill.version, instructions: skill.instructions.length > 0 ? skill.instructions : skill.summary, tools: skill.tools,
  })),
  tools: contributions.flatMap((contribution) => contribution.tools).map((registered) => ({
    id: registered.tool.name,
    version: "1",
    description: registered.tool.description ?? registered.tool.name,
    returns: "tool result",
    permissions: registered.annotations.permissions,
    inputSchema: { ...JSONSchema.make(registered.tool.parametersSchema) },
    outputSchema: { ...JSONSchema.make(registered.tool.successSchema) },
  })),
})
