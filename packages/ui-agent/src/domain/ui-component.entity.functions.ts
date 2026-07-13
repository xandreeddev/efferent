import type { UiComponentAdmission, UiComponentDefinition, UiPropDefinition, UiTemplateAst } from "./ui-component.entity.js"

const SAFE_ID = /^[a-z][a-z0-9.-]{0,95}$/

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`
}

const hash = (value: string): string => value.split("").reduce((state, character) => {
  const mixed = (state ^ character.charCodeAt(0)) >>> 0
  return Math.imul(mixed, 16777619) >>> 0
}, 2166136261).toString(16).padStart(8, "0")

const structuralValue = (definition: UiComponentDefinition): unknown => ({
  renderer: definition.renderer,
  props: [...definition.props].map(({ name, kind, required }) => ({ name, kind, required: required === true })).sort((left, right) => left.name.localeCompare(right.name)),
  slots: [...definition.slots].sort(),
  template: definition.template,
})

export const componentFingerprint = (definition: UiComponentDefinition): string => `ui-${hash(stable(structuralValue(definition)))}`

export const normalizeComponentDefinition = (definition: UiComponentDefinition): UiComponentDefinition => ({
  ...definition,
  variants: [...new Set(definition.variants)].sort(),
  props: [...definition.props].sort((left, right) => left.name.localeCompare(right.name)),
  slots: [...new Set(definition.slots)].sort(),
  fingerprint: componentFingerprint(definition),
})

const propMatches = (kind: UiPropDefinition["kind"], value: unknown): boolean => {
  if (kind === "string") return typeof value === "string"
  if (kind === "number") return typeof value === "number" && Number.isFinite(value)
  if (kind === "boolean") return typeof value === "boolean"
  if (kind === "string-array") return Array.isArray(value) && value.every((entry) => typeof entry === "string")
  if (kind === "item-array") return Array.isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const validateComponentProps = (definition: UiComponentDefinition, props: Readonly<Record<string, unknown>>): ReadonlyArray<string> => [
  ...definition.props.flatMap((contract) => contract.required === true && props[contract.name] === undefined ? [`${definition.id}.${contract.name} is required`] : []),
  ...Object.entries(props).flatMap(([name, value]) => {
    const contract = definition.props.find((candidate) => candidate.name === name)
    if (contract === undefined) return [`${definition.id}.${name} is not a declared prop`]
    return propMatches(contract.kind, value) ? [] : [`${definition.id}.${name} must be ${contract.kind}`]
  }),
]

const templateCycles = (template: UiTemplateAst, id: string, path: ReadonlySet<string>): ReadonlyArray<string> => {
  if (path.has(id)) return [`template contains a cycle at ${id}`]
  const element = template.elements.find((candidate) => candidate.id === id)
  if (element === undefined) return [`template references missing element ${id}`]
  const next = new Set([...path, id])
  return element.children.flatMap((child) => templateCycles(template, child, next))
}

export const validateTemplateAst = (template: UiTemplateAst): ReadonlyArray<string> => {
  const ids = new Set(template.elements.map((element) => element.id))
  return [
    ...(template.elements.length > 64 ? ["template may contain at most 64 elements"] : []),
    ...(ids.size === template.elements.length ? [] : ["template element ids must be unique"]),
    ...(ids.has(template.root) ? [] : ["template root does not exist"]),
    ...template.elements.flatMap((element) => SAFE_ID.test(element.id) ? [] : [`template element id ${element.id} is invalid`]),
    ...(ids.has(template.root) ? templateCycles(template, template.root, new Set()) : []),
  ]
}

export const validateComponentDefinition = (definition: UiComponentDefinition): ReadonlyArray<string> => [
  ...(SAFE_ID.test(definition.id) ? [] : ["component id must be lowercase dot/kebab notation"]),
  ...(definition.variants.length > 16 ? ["component may define at most 16 variants"] : []),
  ...(new Set(definition.props.map((prop) => prop.name)).size === definition.props.length ? [] : ["component prop names must be unique"]),
  ...(definition.renderer === "template" && definition.template === undefined ? ["template renderer requires a template"] : []),
  ...(definition.template === undefined ? [] : validateTemplateAst(definition.template)),
]

const features = (definition: UiComponentDefinition): ReadonlySet<string> => new Set([
  `renderer:${definition.renderer}`,
  ...definition.props.map((prop) => `prop:${prop.name}:${prop.kind}:${prop.required === true ? "required" : "optional"}`),
  ...definition.slots.map((slot) => `slot:${slot}`),
  ...(definition.template?.elements.map((element) => `element:${element.tag}:${element.role}:${element.children.length}`) ?? []),
])

export const componentSimilarity = (left: UiComponentDefinition, right: UiComponentDefinition): number => {
  const leftFeatures = features(left)
  const rightFeatures = features(right)
  const intersection = [...leftFeatures].filter((feature) => rightFeatures.has(feature)).length
  const union = new Set([...leftFeatures, ...rightFeatures]).size
  return union === 0 ? 1 : intersection / union
}

export const admitComponent = (
  candidate: UiComponentDefinition,
  existing: ReadonlyArray<UiComponentDefinition>,
): UiComponentAdmission => {
  const normalized = normalizeComponentDefinition(candidate)
  const scored = existing.map((definition) => ({ definition, similarity: componentSimilarity(normalized, definition) })).sort((left, right) => right.similarity - left.similarity)
  const exact = scored.find((entry) => entry.definition.fingerprint === normalized.fingerprint || entry.similarity === 1)
  if (exact !== undefined) return { definition: exact.definition, disposition: "reused", canonicalId: exact.definition.id, similarity: exact.similarity }
  const variant = scored.find((entry) => entry.similarity >= 0.9 && entry.definition.renderer === normalized.renderer)
  if (variant !== undefined) return { definition: variant.definition, disposition: "variant", canonicalId: variant.definition.id, similarity: variant.similarity }
  return { definition: { ...normalized, status: "workspace" }, disposition: "admitted", canonicalId: normalized.id, similarity: scored[0]?.similarity ?? 0 }
}

const requestTerms = (request: string): ReadonlySet<string> => new Set(request.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2))

export const retrieveComponents = (
  definitions: ReadonlyArray<UiComponentDefinition>,
  request: string,
  limit = 16,
): ReadonlyArray<UiComponentDefinition> => {
  const terms = requestTerms(request)
  const score = (definition: UiComponentDefinition): number => {
    const searchable = `${definition.id} ${definition.category} ${definition.description}`.toLowerCase()
    return [...terms].filter((term) => searchable.includes(term)).length + (definition.status === "core" ? 0.1 : 0)
  }
  const essentials = new Set(["layout.section", "layout.grid", "primitive.heading", "primitive.text", "action.button", "feedback.empty-state"])
  return definitions
    .filter((definition) => definition.status !== "deprecated")
    .map((definition) => ({ definition, score: score(definition) + (essentials.has(definition.id) ? 10 : 0) }))
    .sort((left, right) => right.score - left.score || left.definition.id.localeCompare(right.definition.id))
    .slice(0, limit)
    .map(({ definition }) => definition)
}

export const componentPromptLine = (definition: UiComponentDefinition): string => {
  const props = definition.props.map((prop) => `${prop.name}:${prop.kind}${prop.required === true ? "!" : ""}`).join(",")
  return `${definition.id}${definition.variants.length === 0 ? "" : `[${definition.variants.join("|")}]`} {${props}}`
}
