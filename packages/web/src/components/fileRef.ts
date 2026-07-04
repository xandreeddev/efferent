import { html, join, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import type { FileRefView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * A reference file opened by `read_file` — path header + numbered lines.
 * Keyed by PATH (re-reading a file refreshes its card in place).
 */
export const renderFileRef = (view: FileRefView, oob?: string): Html => {
  const id = domIdForKey("ws-file", view.path)
  const lines = view.content.replace(/\n$/, "").split("\n")
  const hl = view.highlight
  const rendered = lines.map((line, idx) => {
    const no = view.startLine + idx
    const inHl = hl !== undefined && no >= hl.from && no <= hl.to
    return html`<div class="ef-file-line${inHl ? " ef-file-line--hl" : ""}"><span class="ef-file-lineno">${no}</span>${line === "" ? " " : line}</div>`
  })
  return html`<div id="${id}" class="ef-wcard ef-file"${oobAttr(oob)}>
    <div class="ef-wcard-title" title="${view.path}">${view.path}${view.truncated === true ? html` <span class="ef-muted">(truncated)</span>` : ""}</div>
    <div class="ef-file-body">${join(rendered)}</div>
  </div>`
}
