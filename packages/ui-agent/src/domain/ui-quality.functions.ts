import type { UiHostService } from "../ports/ui-host.port.js"
import type { PageManifest, UiBlock, UiPage } from "./ui-page.entity.js"
import type { UiComponentDefinition } from "./ui-component.entity.js"
import { validateComponentProps } from "./ui-component.entity.functions.js"
import { validateThemeIntent } from "./design-system.entity.functions.js"

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/

const expectedRecipe = (archetype: PageManifest["archetype"]): PageManifest["recipe"]["id"] =>
  archetype === "landing" ? "landing.hero-grid" : archetype === "application" ? "app.workspace" : "doc.architecture"

const recordArray = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => Array.isArray(value)
  ? value.filter((entry): entry is Readonly<Record<string, unknown>> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
  : []

const recordStrings = (records: ReadonlyArray<Readonly<Record<string, unknown>>>, key: string): ReadonlyArray<string> =>
  records.flatMap((record) => typeof record[key] === "string" ? [record[key]] : [])

const blockCapabilities = (block: UiBlock): ReadonlyArray<string> => {
  if (block.kind === "hero" || block.kind === "cta") return (block.actions ?? []).map((action) => action.capability)
  if (block.kind === "navigation") return block.action === undefined ? [] : [block.action.capability]
  if (block.kind === "form") return [block.capability]
  if (block.kind === "component") return [
    ...(block.behaviors ?? []).flatMap((behavior) => behavior.type === "action" ? [behavior.capability] : []),
    ...(typeof block.props.capability === "string" ? [block.props.capability] : []),
    ...recordStrings(recordArray(block.props.actions), "capability"),
    ...recordStrings(recordArray(block.props.items), "capability"),
  ]
  return []
}

const blockAssets = (block: UiBlock): ReadonlyArray<string> => {
  if (block.kind === "hero") return block.assetId === undefined ? [] : [block.assetId]
  if (block.kind === "media") return [block.assetId]
  if (block.kind === "cards" || block.kind === "feature-grid") return block.items.flatMap((item) => item.assetId === undefined ? [] : [item.assetId])
  if (block.kind === "component") return [
    ...(typeof block.props.assetId === "string" ? [block.props.assetId] : []),
    ...recordStrings(recordArray(block.props.items), "assetId"),
  ]
  return []
}

const graphFindings = (block: UiBlock): ReadonlyArray<string> => {
  if (block.kind !== "architecture") return []
  const ids = new Set(block.graph.nodes.map((node) => node.id))
  return [
    ...block.graph.nodes.flatMap((node) => SAFE_ID.test(node.id) ? [] : [`diagram node id "${node.id}" must be kebab-case`]),
    ...block.graph.edges.flatMap((edge) => [
      ...(ids.has(edge.from) ? [] : [`diagram edge source "${edge.from}" does not exist`]),
      ...(ids.has(edge.to) ? [] : [`diagram edge target "${edge.to}" does not exist`]),
    ]),
  ]
}

export const validateManifest = (manifest: PageManifest, host: UiHostService): ReadonlyArray<string> => [
  ...(SAFE_ID.test(manifest.id) ? [] : ["page id must be kebab-case"]),
  ...(manifest.recipe.id === expectedRecipe(manifest.archetype) ? [] : [`${manifest.archetype} pages must use ${expectedRecipe(manifest.archetype)}`]),
  ...(host.recipes.has(manifest.recipe.id) ? [] : [`recipe ${manifest.recipe.id} is not registered by this host`]),
  ...(manifest.designSystem.id === host.tokens.id && manifest.designSystem.version === host.tokens.version ? [] : ["page design-system reference does not match the host"]),
  ...(manifest.theme === undefined ? [] : validateThemeIntent(manifest.theme)),
  ...(new Set(manifest.slots.map((slot) => slot.id)).size === manifest.slots.length ? [] : ["slot ids must be unique"]),
]

export const validateBlocks = (
  manifest: PageManifest,
  blocks: ReadonlyArray<UiBlock>,
  host: UiHostService,
  components: ReadonlyMap<string, UiComponentDefinition> = new Map(),
): ReadonlyArray<string> => {
  const slots = new Map(manifest.slots.map((slot) => [slot.id, slot.blockKind]))
  return [
    ...(new Set(blocks.map((block) => block.id)).size === blocks.length ? [] : ["block ids must be unique within a patch"]),
    ...blocks.flatMap((block) => [
      ...(SAFE_ID.test(block.id) ? [] : [`block id "${block.id}" must be kebab-case`]),
      ...(block.kind === "component"
        ? (() => {
          const slot = manifest.slots.find((candidate) => candidate.id === block.id)
          return slot === undefined || (slot.blockKind === "component" && (slot.component === undefined || slot.component === block.component))
            ? []
            : [`component ${block.id} (${block.component}) conflicts with its manifest slot`]
        })()
        : slots.get(block.id) === block.kind ? [] : [`block ${block.id} (${block.kind}) is not declared by the page manifest`]),
      ...(block.kind !== "component" ? [] : (() => {
        const definition = components.get(block.component)
        if (definition === undefined) return [`component ${block.component} is not registered`]
        return [
          ...(block.variant === undefined || definition.variants.includes(block.variant) ? [] : [`component ${block.component} does not provide variant ${block.variant}`]),
          ...validateComponentProps(definition, block.props),
          ...block.children.flatMap((child) => SAFE_ID.test(child) ? [] : [`component child id "${child}" must be kebab-case`]),
          ...(block.children.includes(block.id) ? [`component ${block.id} cannot contain itself`] : []),
        ]
      })()),
      ...blockCapabilities(block).flatMap((capability) => host.actions.has(capability) || host.queries.has(capability) ? [] : [`capability ${capability} is not registered`]),
      ...blockAssets(block).flatMap((asset) => host.assets.has(asset) ? [] : [`asset ${asset} is not registered`]),
      ...graphFindings(block),
    ]),
  ]
}

const requiredKinds: Readonly<Record<PageManifest["archetype"], ReadonlyArray<UiBlock["kind"]>>> = {
  landing: ["hero", "feature-grid", "cta"],
  application: ["navigation", "form", "data-table"],
  document: ["hero", "prose", "architecture", "decisions"],
}

const componentGraphFindings = (page: UiPage): ReadonlyArray<string> => {
  const nodes = new Map(page.blocks.flatMap((block) => block.kind === "component" ? [[block.id, block] as const] : []))
  const visit = (id: string, path: ReadonlySet<string>): ReadonlyArray<string> => {
    if (path.has(id)) return [`component graph contains a cycle at ${id}`]
    const node = nodes.get(id)
    if (node === undefined) return []
    return node.children.flatMap((child) => visit(child, new Set([...path, id])))
  }
  return [
    ...page.blocks.flatMap((block) => block.kind === "component" && block.component.startsWith("navigation.")
      ? recordStrings(recordArray(block.props.items), "target").filter((target) => !nodes.has(target)).map((target) => `navigation target ${target} does not resolve to a component node`)
      : []),
    ...[...nodes.values()].flatMap((node) => visit(node.id, new Set())),
  ]
}

export const validatePageCompleteness = (page: UiPage): ReadonlyArray<string> => {
  const kinds = new Set(page.blocks.map((block) => block.kind))
  const blockIds = new Set(page.blocks.map((block) => block.id))
  const componentMode = kinds.has("component")
  return [
    ...(componentMode ? [] : requiredKinds[page.manifest.archetype].flatMap((kind) => kinds.has(kind) ? [] : [`${page.manifest.archetype} page is missing required ${kind} block`])),
    ...page.manifest.slots.filter((slot) => slot.importance === "critical" && !blockIds.has(slot.id)).map((slot) => `critical slot ${slot.id} is empty`),
    ...page.blocks.flatMap((block) => block.kind === "component" ? block.children.filter((child) => !blockIds.has(child)).map((child) => `component ${block.id} references missing child ${child}`) : []),
    ...componentGraphFindings(page),
  ]
}

export const renderUiAdmissionFindings = (findings: ReadonlyArray<string>): string => findings.map((finding) => `- ${finding}`).join("\n")
