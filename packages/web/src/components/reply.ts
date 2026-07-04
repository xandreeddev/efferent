import { html, type Html } from "../html.js"
import { ID_REPLY } from "../ids.js"
import { renderMarkdown } from "../markdown.js"
import type { ReplyView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * The latest assistant reply as a compact dismissible bubble above the
 * composer — chat-fashion interaction with the transcript drawer closed.
 * `data-key` is the message's identity key: app.js remembers a dismissed key
 * and re-hides same-key upserts, while a NEW key shows the bubble again.
 * `undefined` renders the hidden empty singleton.
 */
export const renderReply = (view: ReplyView | undefined, oob?: string): Html => {
  if (view === undefined) {
    return html`<div id="${ID_REPLY}" class="ef-reply ef-reply--empty"${oobAttr(oob)}></div>`
  }
  return html`<div id="${ID_REPLY}" class="ef-reply" data-key="${view.key}"${oobAttr(oob)}>
    <div class="ef-reply-body ef-prose">${renderMarkdown(view.markdown)}</div>
    <div class="ef-reply-actions">
      <button type="button" class="ef-btn ef-btn--ghost ef-reply-open" data-drawer-toggle="chat" title="open the transcript">chat</button>
      <button type="button" class="ef-btn ef-btn--ghost ef-reply-dismiss" title="dismiss">✕</button>
    </div>
  </div>`
}
