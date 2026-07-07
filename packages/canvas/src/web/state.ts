import { Option } from "effect"
import type { CanvasEvent } from "../session.js"
import type { CanvasEntry } from "../toolkit.js"

/** One built page (accumulated across replace/append renders). */
export interface Page {
  readonly id: string
  readonly title: string
  readonly html: string
}

export interface CanvasModel {
  readonly pages: ReadonlyArray<Page>
  readonly activeId: Option.Option<string>
  readonly busy: boolean
  readonly reply: Option.Option<string>
}

export const emptyModel: CanvasModel = {
  pages: [],
  activeId: Option.none(),
  busy: false,
  reply: Option.none(),
}

const mergeEntry = (model: CanvasModel, entry: CanvasEntry): CanvasModel => {
  const existing = model.pages.find((p) => p.id === entry.id)
  const pages =
    existing === undefined
      ? [...model.pages, { id: entry.id, title: entry.title, html: entry.html }]
      : model.pages.map((p) =>
          p.id === entry.id
            ? {
                id: p.id,
                title: entry.title,
                html: entry.mode === "append" ? p.html + entry.html : entry.html,
              }
            : p,
        )
  // Focus: a NEW page focuses unless active:false; an update pulls focus only
  // on an explicit active:true.
  const focus = existing === undefined ? entry.active : entry.active && entry.mode === "replace"
  return {
    ...model,
    pages,
    activeId: focus
      ? Option.some(entry.id)
      : Option.orElse(model.activeId, () => Option.some(entry.id)),
  }
}

/** Fold one session event into the model (the same fold live and on replay). */
export const reduceEvent = (model: CanvasModel, event: CanvasEvent): CanvasModel => {
  if (event.type === "ui_render") return mergeEntry(model, event.entry)
  if (event.type === "turn_start") return { ...model, busy: true }
  if (event.type === "assistant_message") {
    return event.text.length > 0 ? { ...model, reply: Option.some(event.text) } : model
  }
  if (event.type === "agent_end") return { ...model, busy: false }
  if (event.type === "error") return { ...model, busy: false, reply: Option.some(`⚠ ${event.message}`) }
  return model
}
