import { html, render } from "../html.js"
import { ID_RAIL } from "../ids.js"
import type { Html } from "../html.js"
import type { ChatBlockView } from "../views.js"
import { renderAgentsBlock } from "../components/agents.js"
import { renderInfoLine, renderMessage } from "../components/message.js"
import { renderToolPill } from "../components/toolPill.js"

/** Dispatch a chat block to its component, with an optional OOB attribute. */
export const renderChatBlock = (block: ChatBlockView, oob?: string): Html => {
  switch (block.kind) {
    case "message":
      return renderMessage(block, oob)
    case "tool":
      return renderToolPill(block, oob)
    case "agents":
      return renderAgentsBlock(block, oob)
    case "line":
      return renderInfoLine(block, oob)
  }
}

/**
 * htmx OOB semantics: for selector-style swaps (`beforeend:#target`) htmx
 * inserts the oob element's CHILDREN, discarding the element itself — so an
 * append must ride inside a throwaway wrapper carrying the attribute, or the
 * component's keyed root (`<li id="blk-…">`) is stripped on insert (found
 * live: every appended pill lost its id, and its later update 404'd).
 * `hx-swap-oob="true"` (outerHTML) IS an inline swap and keeps the node, so
 * upserts carry the attribute on the component root directly.
 */
export const wrapAppend = (regionId: string, inner: Html): string =>
  render(html`<div hx-swap-oob="beforeend:#${regionId}">${inner}</div>`)

/** A NEW rail block — appended to the end of the rail (wrapper discarded). */
export const appendChatBlock = (block: ChatBlockView): string =>
  wrapAppend(ID_RAIL, renderChatBlock(block))

/** An UPDATED rail block — outerHTML-replaces the same-id element. */
export const upsertChatBlock = (block: ChatBlockView): string => render(renderChatBlock(block, "true"))
