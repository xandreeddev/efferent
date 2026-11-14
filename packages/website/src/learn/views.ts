// What the UI shows (lesson 6, ADR 0009): views drawn in the chat from the
// journal's view records, folded with the kernel's `viewsOf`. Drawing live
// and redrawing from the journal are the same fold: `draw(records)` is given
// every record of the chat's session each time and changes only what changed.
// Cells are model-written, so everything is drawn as text, never as markup.
import { Match } from "effect"
import { viewsOf } from "@xandreed/sdk/kernel"
import type { Shown, View } from "@xandreed/sdk/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const made = document.createElement(tag)
  if (className !== "") made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

/** A view's body, drawn as text. */
export const viewBody = (view: View): HTMLElement => Match.valueTags(view, {
  Text: ({ text }) => el("p", "vw-text", text),
  List: ({ title, items }) => {
    const box = el("div", "vw-list")
    if (title !== undefined) box.append(el("strong", "vw-title", title))
    const list = el("ul", "")
    items.forEach((item) => list.append(el("li", "", item)))
    box.append(list)
    return box
  },
  Table: ({ title, columns, rows }) => {
    const box = el("div", "vw-table")
    if (title !== undefined) box.append(el("strong", "vw-title", title))
    const scroll = el("div", "vw-scroll")
    const table = el("table", "")
    const head = el("tr", "")
    columns.forEach((column) => head.append(el("th", "", column)))
    table.append(el("thead", ""), el("tbody", ""))
    table.firstElementChild!.append(head)
    rows.forEach((row) => {
      const line = el("tr", "")
      row.forEach((cell) => line.append(el("td", "", cell)))
      table.lastElementChild!.append(line)
    })
    scroll.append(table)
    box.append(scroll)
    return box
  },
  Card: ({ title, body }) => {
    const box = el("div", "vw-card")
    box.append(el("strong", "vw-title", title), el("p", "", body))
    return box
  },
})

/** The views drawn in a chat: one element per id, in the place its id first appeared. */
export interface ViewBoard {
  /** Fold every record of the chat's session, and draw what changed. */
  readonly draw: (records: ReadonlyArray<StoredEvent>) => void
  /** Progress of the work behind a view: a bar on it, or on a placeholder until the view arrives. */
  readonly progress: (id: string, done: number, total: number) => void
  /** A turn ended, however: no progress bar is left behind, and a placeholder no view filled is removed. */
  readonly settle: () => void
  /** Forget every drawn element (the chat was cleared). */
  readonly reset: () => void
  /** How many views are drawn, and their ids in order. */
  readonly shown: () => ReadonlyArray<string>
}

export const viewBoard = (place: () => HTMLElement): ViewBoard => {
  const drawn = new Map<string, { readonly item: HTMLElement; seq: number }>()
  const itemOf = (id: string): HTMLElement => {
    const found = drawn.get(id)
    if (found !== undefined) return found.item
    const item = place()
    item.dataset.view = id
    drawn.set(id, { item, seq: -1 })
    return item
  }
  const paint = (shown: Shown) => {
    const item = itemOf(shown.id)
    const entry = drawn.get(shown.id)!
    if (entry.seq === shown.seq) return
    entry.seq = shown.seq
    const bar = item.querySelector(".vw-progress")
    item.replaceChildren(el("span", "vw-id", shown.id), viewBody(shown.view))
    if (bar !== null) item.append(bar)
    delete item.dataset.placeholder
  }
  return {
    draw: (records) => viewsOf(records).forEach(paint),
    progress: (id, done, total) => {
      const item = itemOf(id)
      if (drawn.get(id)!.seq < 0) { item.dataset.placeholder = ""; if (item.querySelector(".vw-id") === null) item.prepend(el("span", "vw-id", id)) }
      let bar = item.querySelector<HTMLElement>(".vw-progress")
      if (bar === null) {
        bar = el("div", "vw-progress")
        const track = el("div", "vw-track")
        track.append(el("i", ""))
        bar.append(track, el("span", ""))
        item.append(bar)
      }
      bar.querySelector("i")!.setAttribute("style", `width:${Math.round((done / Math.max(1, total)) * 100)}%`)
      bar.querySelector("span")!.textContent = `${done} of ${total}`
      if (done >= total) bar.dataset.done = ""
      else delete bar.dataset.done
    },
    settle: () => {
      for (const [id, { item, seq }] of drawn) {
        item.querySelector(".vw-progress")?.remove()
        if (seq < 0) { item.remove(); drawn.delete(id) }
      }
    },
    reset: () => drawn.clear(),
    shown: () => [...drawn.keys()],
  }
}
