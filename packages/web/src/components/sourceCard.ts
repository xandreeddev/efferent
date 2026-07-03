import { html, join, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import type { SourceCardView } from "../views.js"
import { oobAttr } from "./oob.js"

const SAFE_URL = /^https?:\/\//i

/** A `web_fetch` / `search_web` result — answer excerpt + source links. */
export const renderSourceCard = (view: SourceCardView, oob?: string): Html => {
  const id = domIdForKey("ws-item", view.id)
  const title = view.kind === "search" ? `search: ${view.query ?? ""}` : (view.url ?? "fetch")
  const links = view.sources
    .filter((s) => SAFE_URL.test(s.url))
    .map(
      (s) =>
        html`<a class="ef-source-link" href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title ?? s.url}</a>`,
    )
  return html`<div id="${id}" class="ef-wcard ef-source"${oobAttr(oob)}>
    <div class="ef-wcard-title">${title}${view.status !== undefined ? html` <span class="ef-muted">${view.status}</span>` : ""}</div>
    ${view.answer !== undefined && html`<div class="ef-source-answer">${view.answer}</div>`}
    ${links.length > 0 && html`<div class="ef-source-links">${join(links)}</div>`}
  </div>`
}
