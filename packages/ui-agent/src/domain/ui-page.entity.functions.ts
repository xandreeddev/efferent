import type { PageManifest, UiBlock, UiPage, UiPageEvent } from "./ui-page.entity.js"
import { Option } from "effect"
import type { DesignSystemRef } from "./design-system.entity.js"

export const emptyPage = (manifest: PageManifest): UiPage => ({ manifest, blocks: [], complete: false })

export interface UiAdmissionContract {
  readonly designSystem: DesignSystemRef
  readonly assetIds: ReadonlySet<string>
}

const withoutOptionalAsset = (block: UiBlock, assetIds: ReadonlySet<string>): UiBlock => {
  if (block.kind === "hero" && block.assetId !== undefined && !assetIds.has(block.assetId)) {
    const { assetId: _assetId, ...rest } = block
    return rest
  }
  if (block.kind === "cards" || block.kind === "feature-grid") {
    return {
      ...block,
      items: block.items.map((item) => {
        if (item.assetId === undefined || assetIds.has(item.assetId)) return item
        const { assetId: _assetId, ...rest } = item
        return rest
      }),
    }
  }
  return block
}

const withCanonicalNavTargets = (block: UiBlock): UiBlock =>
  block.kind === "navigation"
    ? {
        ...block,
        links: block.links.map((link) =>
          link.target.startsWith("#") ? { ...link, target: link.target.slice(1) } : link,
        ),
      }
    : block

/** Block-level canonicalization of host-owned addressing, shared by the
 * start_ui AND patch_ui admission paths: unknown optional imagery falls back
 * to renderer artwork, and anchor-style navigation targets ("#features")
 * normalize to the verbatim block id the compiler links by. */
export const canonicalizeUiBlocks = (
  blocks: ReadonlyArray<UiBlock>,
  contract: UiAdmissionContract,
): ReadonlyArray<UiBlock> =>
  blocks.map((block) => withCanonicalNavTargets(withoutOptionalAsset(block, contract.assetIds)))

/** Canonicalize host-owned admission data while preserving every model-owned
 * layout and content decision. The design-system reference is configuration,
 * optional unknown imagery falls back to renderer artwork, and critical
 * blocks omitted from the redundant slot declaration are declared verbatim. */
export const normalizeInitialUiAdmission = (
  manifest: PageManifest,
  blocks: ReadonlyArray<UiBlock>,
  contract: UiAdmissionContract,
): { readonly manifest: PageManifest; readonly blocks: ReadonlyArray<UiBlock> } => {
  const normalizedBlocks = canonicalizeUiBlocks(blocks, contract)
  const slots = new Map(manifest.slots.map((slot) => [slot.id, slot]))
  const missing = normalizedBlocks.flatMap((block) =>
    slots.has(block.id)
      ? []
      : [{ id: block.id, blockKind: block.kind, importance: "critical" as const }],
  )
  return {
    manifest: {
      ...manifest,
      designSystem: contract.designSystem,
      slots: [...manifest.slots, ...missing],
    },
    blocks: normalizedBlocks,
  }
}

const upsertBlocks = (current: ReadonlyArray<UiBlock>, incoming: ReadonlyArray<UiBlock>): ReadonlyArray<UiBlock> =>
  incoming.reduce(
    (blocks, block) =>
      blocks.some((candidate) => candidate.id === block.id)
        ? blocks.map((candidate) => candidate.id === block.id ? block : candidate)
        : [...blocks, block],
    current,
  )

export const reducePageEvent = (page: Option.Option<UiPage>, event: UiPageEvent): Option.Option<UiPage> => {
  if (event.type === "page_opened") {
    return Option.some({ manifest: event.page, blocks: event.blocks, complete: false })
  }
  if (Option.isNone(page) || page.value.manifest.id !== event.pageId) return page
  if (event.type === "blocks_upserted") return Option.some({ ...page.value, blocks: upsertBlocks(page.value.blocks, event.blocks) })
  return Option.some({ ...page.value, complete: true })
}

export const foldPageEvents = (events: ReadonlyArray<UiPageEvent>): ReadonlyArray<UiPage> =>
  events.reduce<ReadonlyArray<UiPage>>((pages, event) => {
    const id = event.type === "page_opened" ? event.page.id : event.pageId
    const current = pages.find((page) => page.manifest.id === id)
    const next = reducePageEvent(Option.fromNullable(current), event)
    return Option.match(next, {
      onNone: () => pages,
      onSome: (value) => current === undefined
        ? [...pages, value]
        : pages.map((page) => page.manifest.id === id ? value : page),
    })
  }, [])
