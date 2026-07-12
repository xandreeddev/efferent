import { Match } from "effect"
import type { RegisteredAssetType, UiBlockType, UiPage } from "@xandreed/ui-agent"
import { html, join, raw, render } from "./html.js"
import type { Html } from "./html.js"
import { renderArchitectureDiagram } from "./architectureDiagram.js"

export interface UiCompileContext {
  readonly pageId: string
  readonly csrfToken: string
  readonly assets: ReadonlyMap<string, RegisteredAssetType>
  readonly capabilities: ReadonlySet<string>
}

const title = (value: string | undefined): Html => value === undefined ? raw("") : html`<h2>${value}</h2>`

const abstractMedia = (label: string): Html => html`<div class="ui-abstract-media" role="img" aria-label="${label}"><span></span><span></span><span></span></div>`

const media = (assetId: string | undefined, context: UiCompileContext): Html => {
  if (assetId === undefined) return abstractMedia("Abstract design-system artwork")
  const asset = context.assets.get(assetId)
  return asset === undefined
    ? abstractMedia("Abstract design-system artwork")
    : html`<img class="ui-media" src="${asset.src}" alt="${asset.alt}" width="${asset.width}" height="${asset.height}" loading="lazy" />`
}

type ActionValue = { readonly capability: string; readonly label: string; readonly variant?: "primary" | "secondary" | "danger" | undefined }
type CardValue = { readonly title: string; readonly body: string; readonly badge?: string | undefined; readonly assetId?: string | undefined }

const action = (value: ActionValue, context: UiCompileContext): Html => {
  const allowed = context.capabilities.has(value.capability)
  const variant = value.variant ?? "secondary"
  return allowed
    ? html`<form class="ui-action" hx-post="/action/host" hx-swap="none"><input type="hidden" name="page-id" value="${context.pageId}" /><input type="hidden" name="capability" value="${value.capability}" /><input type="hidden" name="csrf" value="${context.csrfToken}" /><button class="ui-btn ui-btn--${variant}" type="submit">${value.label}</button></form>`
    : html`<button class="ui-btn ui-btn--secondary" type="button" disabled title="Capability unavailable">${value.label}</button>`
}

const actions = (values: ReadonlyArray<ActionValue> | undefined, context: UiCompileContext): Html =>
  values === undefined ? raw("") : html`<div class="ui-actions">${join(values.map((value) => action(value, context)))}</div>`

const card = (item: CardValue, context: UiCompileContext): Html => html`<article class="ui-card">
  ${item.assetId === undefined ? raw("") : media(item.assetId, context)}
  ${item.badge === undefined ? raw("") : html`<span class="ui-badge">${item.badge}</span>`}<h3>${item.title}</h3><p>${item.body}</p>
</article>`

const renderBlockHtml = (block: UiBlockType, context: UiCompileContext): Html => Match.value(block).pipe(
  Match.when({ kind: "hero" }, (value) => html`<header class="ui-hero" id="${value.id}"><div class="ui-hero-copy">${value.eyebrow === undefined ? raw("") : html`<p class="ui-eyebrow">${value.eyebrow}</p>`}<h1>${value.title}</h1><p class="ui-lede">${value.lede}</p>${actions(value.actions, context)}</div>${media(value.assetId, context)}</header>`),
  Match.when({ kind: "navigation" }, (value) => html`<nav class="ui-navigation" id="${value.id}" aria-label="Primary"><strong>${value.brand}</strong><div>${join(value.links.map((link) => html`<a href="#${link.target}">${link.label}</a>`))}</div>${value.action === undefined ? raw("") : action(value.action, context)}</nav>`),
  Match.when({ kind: "prose" }, (value) => html`<section class="ui-prose" id="${value.id}">${title(value.title)}${join(value.paragraphs.map((paragraph) => html`<p>${paragraph}</p>`))}</section>`),
  Match.when({ kind: "media" }, (value) => html`<figure id="${value.id}">${media(value.assetId, context)}${value.caption === undefined ? raw("") : html`<figcaption>${value.caption}</figcaption>`}</figure>`),
  Match.when({ kind: "feature-grid" }, (value) => html`<section class="ui-section" id="${value.id}">${title(value.title)}<div class="ui-grid">${join(value.items.map((item) => card(item, context)))}</div></section>`),
  Match.when({ kind: "cards" }, (value) => html`<section class="ui-section" id="${value.id}">${title(value.title)}<div class="ui-grid">${join(value.items.map((item) => card(item, context)))}</div></section>`),
  Match.when({ kind: "stats" }, (value) => html`<section class="ui-section" id="${value.id}">${title(value.title)}<div class="ui-stats">${join(value.items.map((item) => html`<div class="ui-stat"><strong>${item.value}</strong><span>${item.label}</span>${item.detail === undefined ? raw("") : html`<small>${item.detail}</small>`}</div>`))}</div></section>`),
  Match.when({ kind: "cta" }, (value) => html`<section class="ui-cta" id="${value.id}"><div><h2>${value.title}</h2><p>${value.body}</p></div>${actions(value.actions, context)}</section>`),
  Match.when({ kind: "form" }, (value) => html`<section class="ui-card" id="${value.id}"><h2>${value.title}</h2><form class="ui-form" hx-post="/action/host" hx-swap="none"><input type="hidden" name="page-id" value="${context.pageId}" /><input type="hidden" name="capability" value="${value.capability}" /><input type="hidden" name="csrf" value="${context.csrfToken}" />${join(value.fields.map((field) => html`<label class="ui-field"><span>${field.label}</span>${field.kind === "textarea" ? html`<textarea name="${field.name}" placeholder="${field.placeholder ?? ""}" ${field.required === true ? raw("required") : raw("")}></textarea>` : field.kind === "select" ? html`<select name="${field.name}" ${field.required === true ? raw("required") : raw("")}>${join((field.options ?? []).map((option) => html`<option>${option}</option>`))}</select>` : html`<input type="${field.kind}" name="${field.name}" placeholder="${field.placeholder ?? ""}" ${field.required === true ? raw("required") : raw("")} />`}</label>`))}<button class="ui-btn ui-btn--primary" type="submit">${value.submitLabel}</button></form></section>`),
  Match.when({ kind: "data-table" }, (value) => html`<section class="ui-section" id="${value.id}"><h2>${value.title}</h2>${value.rows.length === 0 ? html`<p class="ui-empty">${value.empty}</p>` : html`<div class="ui-table-wrap"><table class="ui-table"><thead><tr>${join(value.columns.map((column) => html`<th>${column.label}</th>`))}</tr></thead><tbody>${join(value.rows.map((row) => html`<tr>${join(value.columns.map((column) => html`<td>${row[column.key] ?? ""}</td>`))}</tr>`))}</tbody></table></div>`}</section>`),
  Match.when({ kind: "tabs" }, (value) => html`<section class="ui-tabs" id="${value.id}" x-data="{tab:0}">${title(value.title)}<div role="tablist">${join(value.tabs.map((tab, index) => html`<button class="ui-tab" type="button" role="tab" @click="tab=${index}" :aria-selected="tab===${index}">${tab.label}</button>`))}</div>${join(value.tabs.map((tab, index) => html`<article class="ui-card" x-show="tab===${index}"><p>${tab.body}</p></article>`))}</section>`),
  Match.when({ kind: "code" }, (value) => html`<section class="ui-code" id="${value.id}">${title(value.title)}<pre><code data-language="${value.language}">${value.code}</code></pre></section>`),
  Match.when({ kind: "callout" }, (value) => html`<aside class="ui-callout ui-callout--${value.tone}" id="${value.id}"><h3>${value.title}</h3><p>${value.body}</p></aside>`),
  Match.when({ kind: "timeline" }, (value) => html`<section class="ui-section" id="${value.id}"><h2>${value.title}</h2><ol class="ui-timeline">${join(value.items.map((item) => html`<li><h3>${item.title}</h3><p>${item.body}</p></li>`))}</ol></section>`),
  Match.when({ kind: "decisions" }, (value) => html`<section class="ui-section" id="${value.id}"><h2>${value.title}</h2><div class="ui-grid">${join(value.items.map((item) => html`<article class="ui-card"><span class="ui-badge ui-badge--${item.status}">${item.status}</span><h3>${item.decision}</h3><p>${item.rationale}</p></article>`))}</div></section>`),
  Match.when({ kind: "architecture" }, (value) => html`<section class="ui-section" id="${value.id}">${renderArchitectureDiagram(value.graph)}</section>`),
  Match.exhaustive,
)

export const renderUiBlock = (block: UiBlockType, context: UiCompileContext): string => render(renderBlockHtml(block, context))

export const renderUiPage = (page: UiPage, context: UiCompileContext): string => render(html`<div class="ui-page ui-page--${page.manifest.archetype}" data-recipe="${page.manifest.recipe.id}">${join(page.blocks.map((block) => renderBlockHtml(block, context)))}</div>`)
