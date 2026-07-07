import { html, join, type Html } from "../html.js"
import { ID_QUEUE } from "../ids.js"
import type { QueueView } from "../views.js"
import { oobAttr } from "./oob.js"

/** Pending prompts while a turn runs — a singleton above the composer. */
export const renderQueue = (view: QueueView, oob?: string): Html =>
  html`<div id="${ID_QUEUE}" class="ef-queue${view.items.length === 0 ? " ef-queue--empty" : ""}"${oobAttr(oob)}>${join(
    view.items.map((item) => html`<div class="ef-queue-item">▸ ${item}</div>`),
  )}</div>`
