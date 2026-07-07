import { Option } from "effect"
import { html, join, raw, render, sanitizeHtml } from "@xandreed/surface"
import type { Html } from "@xandreed/surface"
import type { CanvasModel, Page } from "./state.js"

/**
 * Model → htmx fragments. Chrome ids/classes live on the `ef-` prefix the
 * surface sanitizer FORBIDS in agent content (and page containers on `ui-`),
 * so agent HTML can never spoof the shell. Agent HTML crosses into markup at
 * exactly ONE seam: `sanitizeHtml` inside {@link renderPage}.
 */

const isActive = (model: CanvasModel, id: string): boolean =>
  Option.getOrElse(model.activeId, () => "") === id

export const renderPage = (model: CanvasModel, page: Page, oob: boolean): Html => {
  const body = sanitizeHtml(page.html).html
  return html`<section id="ui-${page.id}" class="ef-page-host" data-page="${page.id}" ${
    oob ? raw(`hx-swap-oob="outerHTML:#ui-${page.id}"`) : raw("")
  } ${isActive(model, page.id) ? raw("") : raw("hidden")}>${body}</section>`
}

export const renderTabs = (model: CanvasModel, oob: boolean): Html =>
  html`<nav id="ef-tabs" class="ef-tabs-bar" ${oob ? raw(`hx-swap-oob="true"`) : raw("")}>${join(
    model.pages.map(
      (p) =>
        html`<button type="button" class="ef-tab-btn${isActive(model, p.id) ? " is-active" : ""}" data-tab="${p.id}">${p.title}</button>`,
    ),
  )}</nav>`

export const renderStatus = (model: CanvasModel, oob: boolean): Html =>
  html`<div id="ef-status" class="ef-status-strip" ${oob ? raw(`hx-swap-oob="true"`) : raw("")}>${
    model.busy ? html`<span class="ef-spin">building…</span>` : raw("")
  }${Option.match(model.reply, {
    onNone: () => raw(""),
    onSome: (text) => html`<span class="ef-reply-line">${text.slice(0, 240)}</span>`,
  })}</div>`

/** A brand-new page arrives as an append into the pages region. */
export const renderNewPage = (model: CanvasModel, page: Page): Html =>
  html`<div hx-swap-oob="beforeend:#ef-pages">${renderPage(model, page, false)}</div>`

/** One WS message carrying every region the event touched. */
export const wsMessage = (parts: ReadonlyArray<Html>): string => render(join(parts))
