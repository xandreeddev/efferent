import { html, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import { renderMarkdown } from "../markdown.js"
import type { ChatBlockView } from "../views.js"
import { oobAttr } from "./oob.js"

type MessageView = Extract<ChatBlockView, { kind: "message" }>
type LineView = Extract<ChatBlockView, { kind: "line" }>

/** A prose rail block: user line, assistant markdown, or reasoning aside. */
export const renderMessage = (view: MessageView, oob?: string): Html => {
  const id = domIdForKey("blk", view.key)
  const body =
    view.role === "user"
      ? html`<span class="ef-msg-caret">❯</span> <span class="ef-msg-text">${view.markdown}</span>`
      : html`<div class="ef-prose">${renderMarkdown(view.markdown)}</div>`
  return html`<li id="${id}" class="ef-msg ef-msg--${view.role}"${oobAttr(oob)}>${body}</li>`
}

/** A quiet transient rail line (info / error / checkpoint). */
export const renderInfoLine = (view: LineView, oob?: string): Html => {
  const id = domIdForKey("blk", view.key)
  return html`<li id="${id}" class="ef-line ef-line--${view.tone}"${oobAttr(oob)}>${view.text}</li>`
}
