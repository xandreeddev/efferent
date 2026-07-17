import type { PageManifest, PageManifestInput, PageSlot, PageSlotInput, UiBlock, UiPage, UiPageEvent } from "./ui-page.entity.js"
import { Option } from "effect"
import type { DesignSystemRef } from "./design-system.entity.js"
import { UI_AGENT_RECIPE_SET_VERSION } from "./ui-agent-profile.entity.js"
import { expectedRecipe } from "./ui-quality.functions.js"

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

/** Expand one wire slot: a bare id becomes a compact component-mode slot,
 * and omitted metadata defaults — `critical` importance keeps the
 * completeness gate at full strength for every declared root. */
const expandSlotInput = (slot: PageSlotInput): PageSlot =>
  typeof slot === "string"
    ? { id: slot, blockKind: "component", importance: "critical" }
    : {
        id: slot.id,
        blockKind: slot.blockKind ?? "component",
        ...(slot.component === undefined ? {} : { component: slot.component }),
        importance: slot.importance ?? "critical",
      }

/** Canonicalize host-owned admission data while preserving every model-owned
 * layout and content decision (the ui-latency plan's Phase 1: the model
 * emits only what it genuinely owns — id, title, archetype, the compact
 * slot plan, and an optional theme):
 * - the recipe follows from the archetype when omitted;
 * - the design-system reference is configuration (always host-owned);
 * - compact slots expand with defaulted metadata, and a declared slot whose
 *   kind was defaulted takes the concrete kind of an arriving initial block;
 * - optional unknown imagery falls back to renderer artwork;
 * - blocks omitted from the slot plan are declared verbatim as critical. */
export const normalizeInitialUiAdmission = (
  manifest: PageManifestInput,
  blocks: ReadonlyArray<UiBlock>,
  contract: UiAdmissionContract,
): { readonly manifest: PageManifest; readonly blocks: ReadonlyArray<UiBlock> } => {
  const normalizedBlocks = canonicalizeUiBlocks(blocks, contract)
  const byId = new Map(normalizedBlocks.map((block) => [block.id, block]))
  const declared = (manifest.slots ?? []).map((slot) => {
    const expanded = expandSlotInput(slot)
    const block = byId.get(expanded.id)
    if (block === undefined || (expanded.blockKind === "component" && expanded.component !== undefined)) return expanded
    return block.kind === "component"
      ? { ...expanded, blockKind: "component", component: block.component }
      : { ...expanded, blockKind: block.kind }
  })
  const slots = new Map(declared.map((slot) => [slot.id, slot]))
  const missing = normalizedBlocks.flatMap((block) =>
    slots.has(block.id)
      ? []
      : [{ id: block.id, blockKind: block.kind, component: block.kind === "component" ? block.component : undefined, importance: "critical" as const }],
  )
  return {
    manifest: {
      id: manifest.id,
      title: manifest.title,
      archetype: manifest.archetype,
      recipe: manifest.recipe ?? { id: expectedRecipe(manifest.archetype), version: UI_AGENT_RECIPE_SET_VERSION },
      designSystem: contract.designSystem,
      ...(manifest.theme === undefined ? {} : { theme: manifest.theme }),
      slots: [...declared, ...missing],
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
    // Re-opening an EXISTING page MERGES: the manifest is replaced (the later
    // start is the authoritative full version) but accepted blocks are
    // upserted, never wiped. Streaming admission opens the page from the
    // argument prefix before the settled call fires its own page_opened —
    // and a disconnected stage's late settled call must not erase composer
    // progress either.
    return Option.match(page, {
      onNone: () => Option.some({ manifest: event.page, blocks: event.blocks, complete: false }),
      onSome: (existing) => Option.some({
        manifest: event.page,
        blocks: upsertBlocks(existing.blocks, event.blocks),
        complete: existing.complete,
      }),
    })
  }
  if (Option.isNone(page) || page.value.manifest.id !== event.pageId) return page
  if (event.type === "blocks_upserted") return Option.some({ ...page.value, blocks: upsertBlocks(page.value.blocks, event.blocks) })
  if (event.type === "theme_patched") return Option.some({ ...page.value, manifest: { ...page.value.manifest, theme: event.theme } })
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
