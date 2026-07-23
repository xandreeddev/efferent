import { Option } from "effect"
import { html, join, raw, render, renderUiPage, sanitizeHtml } from "@xandreed/surface"
import type { Html, UiCompileContext } from "@xandreed/surface"
import type { CanvasModel, Page } from "./state.js"
import { pageId, pageTitle } from "./state.js"

const isActive = (model: CanvasModel, id: string): boolean => Option.getOrElse(model.activeId, () => "") === id

export const renderPage = (model: CanvasModel, page: Page, oob: boolean, context: UiCompileContext): Html => {
  const id = pageId(page)
  const body = page.kind === "legacy"
    ? render(sanitizeHtml(page.html, { alpine: true }).html)
    : renderUiPage(page.page, { ...context, pageId: id })
  return html`<section id="ui-${id}" class="ef-page-host" data-page="${id}" ${oob ? raw(`hx-swap-oob="outerHTML:#ui-${id}"`) : raw("")} ${isActive(model, id) ? raw("") : raw("hidden")}>${raw(body)}</section>`
}

export const renderTabs = (model: CanvasModel, oob: boolean): Html => html`<nav id="ef-tabs" class="ef-tabs-bar" ${oob ? raw(`hx-swap-oob="true"`) : raw("")}>${join(model.pages.map((page) => html`<button type="button" class="ef-tab-btn${isActive(model, pageId(page)) ? " is-active" : ""}" data-tab="${pageId(page)}">${pageTitle(page)}</button>`))}</nav>`

export const renderStatus = (model: CanvasModel, oob: boolean): Html => html`<div id="ef-status" class="ef-status-strip" ${oob ? raw(`hx-swap-oob="true"`) : raw("")}>${model.busy ? html`<span class="ef-spin">building…</span>` : raw("")}${Option.match(model.failed, { onNone: () => raw(""), onSome: (message) => html`<span class="ef-failed" role="alert">generation failed — ${message.slice(0, 200)} · accepted blocks remain; send again to retry</span>` })}${Option.match(model.reply, { onNone: () => raw(""), onSome: (text) => html`<span class="ef-reply-line">${text.slice(0, 240)}</span>` })}${Option.match(model.firstBlockAt, { onNone: () => raw(""), onSome: (at) => Option.match(model.requestStartedAt, { onNone: () => raw(""), onSome: (start) => html`<span class="ef-latency">first block ${at - start}ms</span>` }) })}</div>`

export const renderNewPage = (model: CanvasModel, page: Page, context: UiCompileContext): Html => html`<div hx-swap-oob="beforeend:#ef-pages">${renderPage(model, page, false, context)}</div>`

/** The host-owned loading skeleton: visible from the instant a request is
 *  sent until the first real page block lands — perceived latency belongs
 *  to the host, not the model. Chrome only, never model content. */
export const renderSkeleton = (visible: boolean): Html =>
  html`<div id="ef-skeleton" class="ef-skeleton" hx-swap-oob="outerHTML:#ef-skeleton" ${visible ? raw("") : raw("hidden")}><div class="ef-skeleton-bar ef-skeleton-wide"></div><div class="ef-skeleton-bar"></div><div class="ef-skeleton-bar ef-skeleton-short"></div></div>`

export const wsMessage = (parts: ReadonlyArray<Html>): string => render(join(parts))
