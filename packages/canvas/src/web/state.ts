import { Option } from "effect"
import { reducePageEvent } from "@xandreed/ui-agent"
import type { UiPage, UiPageEvent } from "@xandreed/ui-agent"
import type { CanvasEvent, LegacyCanvasEntry } from "../session.js"

export type Page =
  | { readonly kind: "structured"; readonly page: UiPage }
  | { readonly kind: "legacy"; readonly id: string; readonly title: string; readonly html: string }

export interface CanvasModel {
  readonly pages: ReadonlyArray<Page>
  readonly activeId: Option.Option<string>
  readonly busy: boolean
  readonly reply: Option.Option<string>
  readonly requestStartedAt: Option.Option<number>
  readonly firstBlockAt: Option.Option<number>
  readonly completedAt: Option.Option<number>
}

export const emptyModel: CanvasModel = {
  pages: [],
  activeId: Option.none(),
  busy: false,
  reply: Option.none(),
  requestStartedAt: Option.none(),
  firstBlockAt: Option.none(),
  completedAt: Option.none(),
}

export const pageId = (page: Page): string => page.kind === "legacy" ? page.id : page.page.manifest.id
export const pageTitle = (page: Page): string => page.kind === "legacy" ? page.title : page.page.manifest.title

const mergeLegacy = (model: CanvasModel, entry: LegacyCanvasEntry): CanvasModel => {
  const existing = model.pages.find((page) => pageId(page) === entry.id)
  const pages = existing === undefined
    ? [...model.pages, { kind: "legacy" as const, id: entry.id, title: entry.title, html: entry.html }]
    : model.pages.map((page) => pageId(page) !== entry.id ? page : {
        kind: "legacy" as const,
        id: entry.id,
        title: entry.title,
        html: page.kind === "legacy" && entry.mode === "append" ? page.html + entry.html : entry.html,
      })
  return { ...model, pages, activeId: entry.active ? Option.some(entry.id) : model.activeId }
}

const mergeStructured = (model: CanvasModel, event: UiPageEvent): CanvasModel => {
  const id = event.type === "page_opened" ? event.page.id : event.pageId
  const current = model.pages.find((page) => page.kind === "structured" && page.page.manifest.id === id)
  const nextOption = reducePageEvent(current?.kind === "structured" ? Option.some(current.page) : Option.none(), event)
  if (Option.isNone(nextOption)) return model
  const next = nextOption.value
  const pages = current === undefined
    ? [...model.pages, { kind: "structured" as const, page: next }]
    : model.pages.map((page) => pageId(page) === id ? { kind: "structured" as const, page: next } : page)
  const firstBlockAt = Option.isNone(model.firstBlockAt) && next.blocks.length > 0 ? Option.some(event.at) : model.firstBlockAt
  const completedAt = event.type === "page_completed" ? Option.some(event.at) : model.completedAt
  return { ...model, pages, activeId: Option.some(id), firstBlockAt, completedAt }
}

export const reduceEvent = (model: CanvasModel, event: CanvasEvent): CanvasModel => {
  if (event.type === "ui_render") return mergeLegacy(model, event.entry)
  if (event.type === "page_opened" || event.type === "blocks_upserted" || event.type === "theme_patched" || event.type === "page_completed") return mergeStructured(model, event)
  if (event.type === "turn_start") return { ...model, busy: true, requestStartedAt: Option.some(Date.now()), firstBlockAt: Option.none(), completedAt: Option.none() }
  if (event.type === "assistant_message") return event.text.length > 0 ? { ...model, reply: Option.some(event.text) } : model
  if (event.type === "agent_end") return { ...model, busy: false }
  if (event.type === "error") return { ...model, busy: false, reply: Option.some(`⚠ ${event.message}`) }
  return model
}
