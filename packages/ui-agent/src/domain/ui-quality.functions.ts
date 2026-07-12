import type { UiHostService } from "../ports/ui-host.port.js"
import type { PageManifest, UiBlock, UiPage } from "./ui-page.entity.js"

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/

const expectedRecipe = (archetype: PageManifest["archetype"]): PageManifest["recipe"]["id"] =>
  archetype === "landing" ? "landing.hero-grid" : archetype === "application" ? "app.workspace" : "doc.architecture"

const blockCapabilities = (block: UiBlock): ReadonlyArray<string> => {
  if (block.kind === "hero" || block.kind === "cta") return (block.actions ?? []).map((action) => action.capability)
  if (block.kind === "navigation") return block.action === undefined ? [] : [block.action.capability]
  if (block.kind === "form") return [block.capability]
  return []
}

const blockAssets = (block: UiBlock): ReadonlyArray<string> => {
  if (block.kind === "hero") return block.assetId === undefined ? [] : [block.assetId]
  if (block.kind === "media") return [block.assetId]
  if (block.kind === "cards" || block.kind === "feature-grid") return block.items.flatMap((item) => item.assetId === undefined ? [] : [item.assetId])
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
  ...(new Set(manifest.slots.map((slot) => slot.id)).size === manifest.slots.length ? [] : ["slot ids must be unique"]),
]

export const validateBlocks = (manifest: PageManifest, blocks: ReadonlyArray<UiBlock>, host: UiHostService): ReadonlyArray<string> => {
  const slots = new Map(manifest.slots.map((slot) => [slot.id, slot.blockKind]))
  return [
    ...(new Set(blocks.map((block) => block.id)).size === blocks.length ? [] : ["block ids must be unique within a patch"]),
    ...blocks.flatMap((block) => [
      ...(SAFE_ID.test(block.id) ? [] : [`block id "${block.id}" must be kebab-case`]),
      ...(slots.get(block.id) === block.kind ? [] : [`block ${block.id} (${block.kind}) is not declared by the page manifest`]),
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

export const validatePageCompleteness = (page: UiPage): ReadonlyArray<string> => {
  const kinds = new Set(page.blocks.map((block) => block.kind))
  const blockIds = new Set(page.blocks.map((block) => block.id))
  return [
    ...requiredKinds[page.manifest.archetype].flatMap((kind) => kinds.has(kind) ? [] : [`${page.manifest.archetype} page is missing required ${kind} block`]),
    ...page.manifest.slots.filter((slot) => slot.importance === "critical" && !blockIds.has(slot.id)).map((slot) => `critical slot ${slot.id} is empty`),
  ]
}

export const renderUiAdmissionFindings = (findings: ReadonlyArray<string>): string => findings.map((finding) => `- ${finding}`).join("\n")
