import type { PageManifest, UiBlock, UiPage, UiPageEvent } from "./ui-page.entity.js"
import { Option } from "effect"

export const emptyPage = (manifest: PageManifest): UiPage => ({ manifest, blocks: [], complete: false })

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
