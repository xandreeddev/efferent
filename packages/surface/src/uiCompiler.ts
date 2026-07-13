import { Match } from "effect"
import type { RegisteredAssetType, UiBlockType, UiComponentDefinitionType, UiComponentNodeType, UiPage, UiTemplateAstType } from "@xandreed/ui-agent"
import { html, join, raw, render } from "./html.js"
import type { Html } from "./html.js"
import { renderArchitectureDiagram } from "./architectureDiagram.js"

export interface UiCompileContext {
  readonly pageId: string
  readonly csrfToken: string
  readonly assets: ReadonlyMap<string, RegisteredAssetType>
  readonly capabilities: ReadonlySet<string>
  readonly components?: ReadonlyMap<string, UiComponentDefinitionType>
  readonly theme?: { readonly id: string; readonly href: string }
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

type UnknownRecord = Readonly<Record<string, unknown>>

const recordValue = (value: unknown): UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : {}
const stringValue = (record: UnknownRecord, key: string, fallback = ""): string => typeof record[key] === "string" ? record[key] : fallback
const numberValue = (record: UnknownRecord, key: string, fallback = 0): number => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : fallback
const recordsValue = (record: UnknownRecord, key: string): ReadonlyArray<UnknownRecord> => Array.isArray(record[key]) ? (record[key] as ReadonlyArray<unknown>).map(recordValue) : []
const stringsValue = (record: UnknownRecord, key: string): ReadonlyArray<string> => Array.isArray(record[key]) ? (record[key] as ReadonlyArray<unknown>).filter((entry): entry is string => typeof entry === "string") : []

const recordActions = (record: UnknownRecord, context: UiCompileContext): Html => {
  const values = recordsValue(record, "actions").flatMap((item): ReadonlyArray<ActionValue> => {
    const capability = stringValue(item, "capability")
    const label = stringValue(item, "label")
    const variant = stringValue(item, "variant")
    return label.length === 0 || capability.length === 0 ? [] : [{ capability, label, ...(variant === "primary" || variant === "danger" ? { variant } : { variant: "secondary" as const }) }]
  })
  return actions(values, context)
}

const componentItems = (props: UnknownRecord, context: UiCompileContext): Html => join(recordsValue(props, "items").map((item) => card({
  title: stringValue(item, "title", stringValue(item, "label", "Item")),
  body: stringValue(item, "body", stringValue(item, "detail")),
  badge: stringValue(item, "badge") || undefined,
  assetId: stringValue(item, "assetId") || undefined,
}, context)))

const componentHeading = (props: UnknownRecord): Html => {
  const eyebrow = stringValue(props, "eyebrow")
  const heading = stringValue(props, "title", stringValue(props, "text"))
  return html`${eyebrow.length === 0 ? raw("") : html`<p class="ui-eyebrow">${eyebrow}</p>`}${heading.length === 0 ? raw("") : html`<h2>${heading}</h2>`}`
}

const componentField = (field: UnknownRecord): Html => {
  const kind = stringValue(field, "kind", "text")
  const name = stringValue(field, "name")
  const control = kind === "textarea"
    ? html`<textarea name="${name}" placeholder="${stringValue(field, "placeholder")}"></textarea>`
    : kind === "select"
      ? html`<select name="${name}">${join(stringsValue(field, "options").map((option) => html`<option>${option}</option>`))}</select>`
      : html`<input type="${kind === "email" || kind === "number" || kind === "checkbox" ? kind : "text"}" name="${name}" placeholder="${stringValue(field, "placeholder")}" />`
  return html`<label class="ui-field"><span>${stringValue(field, "label")}</span>${control}</label>`
}

const bindingText = (binding: { readonly source: "literal" | "prop"; readonly value: string } | undefined, props: UnknownRecord): string => binding === undefined ? "" : binding.source === "literal" ? binding.value : stringValue(props, binding.value)

const renderTemplate = (template: UiTemplateAstType, props: UnknownRecord): Html => {
  const elements = new Map(template.elements.map((element) => [element.id, element]))
  const visit = (id: string, seen: ReadonlySet<string>): Html => {
    if (seen.has(id)) return html`<span class="ui-component-error">component cycle</span>`
    const element = elements.get(id)
    if (element === undefined) return html`<span class="ui-component-placeholder">component part pending</span>`
    const content = html`${bindingText(element.text, props)}${join(element.children.map((child) => visit(child, new Set([...seen, id]))))}`
    const role = `ui-template-${element.role}`
    const tags: Readonly<Record<string, (body: Html) => Html>> = {
      article: (body) => html`<article class="${role}">${body}</article>`,
      aside: (body) => html`<aside class="${role}">${body}</aside>`,
      div: (body) => html`<div class="${role}">${body}</div>`,
      header: (body) => html`<header class="${role}">${body}</header>`,
      li: (body) => html`<li class="${role}">${body}</li>`,
      nav: (body) => html`<nav class="${role}">${body}</nav>`,
      p: (body) => html`<p class="${role}">${body}</p>`,
      section: (body) => html`<section class="${role}">${body}</section>`,
      small: (body) => html`<small class="${role}">${body}</small>`,
      span: (body) => html`<span class="${role}">${body}</span>`,
      strong: (body) => html`<strong class="${role}">${body}</strong>`,
      ul: (body) => html`<ul class="${role}">${body}</ul>`,
    }
    return (tags[element.tag] ?? tags.div!)(content)
  }
  return visit(template.root, new Set())
}

const renderComponentBehaviors = (node: UiComponentNodeType, context: UiCompileContext): Html => actions((node.behaviors ?? []).flatMap((behavior): ReadonlyArray<ActionValue> => behavior.type === "action" ? [{ capability: behavior.capability, label: behavior.label, variant: behavior.variant }] : []), context)

const renderComponentNode = (
  node: UiComponentNodeType,
  nodes: ReadonlyMap<string, UiComponentNodeType>,
  context: UiCompileContext,
  seen: ReadonlySet<string>,
): Html => {
  if (seen.has(node.id)) return html`<div class="ui-component-error">Component graph cycle at ${node.id}</div>`
  const definition = context.components?.get(node.component)
  if (definition === undefined) return html`<section class="ui-component-error" id="${node.id}"><strong>Unsupported component</strong><p>${node.component}</p></section>`
  const nextSeen = new Set([...seen, node.id])
  const children = join(node.children.map((id) => {
    const child = nodes.get(id)
    return child === undefined
      ? html`<div class="ui-component-placeholder" data-pending-node="${id}" aria-busy="true"><span></span><span></span></div>`
      : renderComponentNode(child, nodes, context, nextSeen)
  }))
  const props = node.props
  const titleText = stringValue(props, "title")
  const bodyText = stringValue(props, "body", stringValue(props, "text", stringValue(props, "lede")))
  const variant = node.variant ?? "default"
  const contentByRenderer: Readonly<Record<UiComponentDefinitionType["renderer"], () => Html>> = {
    layout: () => html`${componentHeading(props)}${bodyText.length === 0 ? raw("") : html`<p>${bodyText}</p>`}<div class="ui-component-children">${children}</div>`,
    navigation: () => html`<strong>${stringValue(props, "brand", titleText)}</strong><div class="ui-nav-links">${join(recordsValue(props, "items").map((item) => html`<a href="#${stringValue(item, "target")}">${stringValue(item, "label")}</a>`))}</div>${recordActions(props, context)}${children}`,
    hero: () => html`<div class="ui-hero-copy">${componentHeading(props)}${bodyText.length === 0 ? raw("") : html`<p class="ui-lede">${bodyText}</p>`}${recordActions(props, context)}${renderComponentBehaviors(node, context)}</div>${media(stringValue(props, "assetId") || undefined, context)}${children}`,
    text: () => html`${componentHeading(props)}${stringsValue(props, "paragraphs").length > 0 ? join(stringsValue(props, "paragraphs").map((paragraph) => html`<p>${paragraph}</p>`)) : bodyText.length === 0 ? raw("") : html`<p>${bodyText}</p>`}${children}`,
    action: () => html`${recordsValue(props, "items").length > 0 ? actions(recordsValue(props, "items").flatMap((item): ReadonlyArray<ActionValue> => {
      const label = stringValue(item, "label")
      const capability = stringValue(item, "capability")
      return label.length === 0 || capability.length === 0 ? [] : [{ label, capability, variant: "secondary" }]
    }), context) : action({ label: stringValue(props, "label", "Continue"), capability: stringValue(props, "capability"), variant: variant === "primary" || variant === "danger" ? variant : "secondary" }, context)}${children}`,
    cards: () => html`${componentHeading(props)}${bodyText.length === 0 ? raw("") : html`<p>${bodyText}</p>`}<div class="ui-grid">${componentItems(props, context)}${children}</div>`,
    stats: () => html`${componentHeading(props)}<div class="ui-stats">${recordsValue(props, "items").length === 0 ? html`<div class="ui-stat"><strong>${stringValue(props, "value")}</strong><span>${stringValue(props, "label")}</span></div>` : join(recordsValue(props, "items").map((item) => html`<div class="ui-stat"><strong>${stringValue(item, "value")}</strong><span>${stringValue(item, "label")}</span><small>${stringValue(item, "detail")}</small></div>`))}</div>${children}`,
    form: () => {
      const capability = stringValue(props, "capability")
      const fields = join(recordsValue(props, "fields").map(componentField))
      return html`${componentHeading(props)}${capability.length > 0 && context.capabilities.has(capability)
        ? html`<form class="ui-form" hx-post="/action/host" hx-swap="none"><input type="hidden" name="page-id" value="${context.pageId}" /><input type="hidden" name="capability" value="${capability}" /><input type="hidden" name="csrf" value="${context.csrfToken}" />${fields}<button class="ui-btn ui-btn--primary" type="submit">${stringValue(props, "submitLabel", "Submit")}</button></form>`
        : html`<div class="ui-form">${fields}<button class="ui-btn ui-btn--primary" type="button" disabled title="Capability unavailable">${stringValue(props, "submitLabel", "Submit")}</button></div>`}${children}`
    },
    table: () => {
      const columns = recordsValue(props, "columns")
      const rows = recordsValue(props, "rows")
      return html`${componentHeading(props)}${rows.length === 0 ? html`<p class="ui-empty">${stringValue(props, "empty", "No results")}</p>` : html`<div class="ui-table-wrap"><table class="ui-table"><thead><tr>${join(columns.map((column) => html`<th>${stringValue(column, "label")}</th>`))}</tr></thead><tbody>${join(rows.map((row) => html`<tr>${join(columns.map((column) => html`<td>${stringValue(row, stringValue(column, "key"))}</td>`))}</tr>`))}</tbody></table></div>`}${children}`
    },
    tabs: () => html`${componentHeading(props)}<div x-data="{tab:0}"><div role="tablist">${join(recordsValue(props, "items").map((item, index) => html`<button class="ui-tab" type="button" role="tab" @click="tab=${index}" :aria-selected="tab===${index}">${stringValue(item, "label", stringValue(item, "title"))}</button>`))}</div>${join(recordsValue(props, "items").map((item, index) => html`<article class="ui-card" x-show="tab===${index}"><p>${stringValue(item, "body")}</p></article>`))}</div>${children}`,
    callout: () => html`<h3>${titleText}</h3><p>${bodyText}</p>${children}`,
    timeline: () => html`${componentHeading(props)}<ol class="ui-timeline">${join(recordsValue(props, "items").map((item) => html`<li><h3>${stringValue(item, "title")}</h3><p>${stringValue(item, "body")}</p></li>`))}</ol>${children}`,
    code: () => html`${componentHeading(props)}<pre><code data-language="${stringValue(props, "language")}">${stringValue(props, "code", bodyText)}</code></pre>${children}`,
    cta: () => html`<div><h2>${titleText}</h2><p>${bodyText}</p></div>${recordActions(props, context)}${renderComponentBehaviors(node, context)}${children}`,
    media: () => html`${media(stringValue(props, "assetId") || undefined, context)}${stringValue(props, "caption").length === 0 ? raw("") : html`<p>${stringValue(props, "caption")}</p>`}${children}`,
    feedback: () => html`${componentHeading(props)}${bodyText.length === 0 ? raw("") : html`<p>${bodyText}</p>`}${numberValue(props, "value", -1) < 0 ? raw("") : html`<progress class="ui-progress" value="${Math.max(0, Math.min(100, numberValue(props, "value")))}" max="100">${numberValue(props, "value")}%</progress>`}${renderComponentBehaviors(node, context)}${children}`,
    template: () => html`${definition.template === undefined ? raw("") : renderTemplate(definition.template, props)}${children}${renderComponentBehaviors(node, context)}`,
  }
  return html`<section class="ui-component ui-component--${definition.renderer} ui-${definition.category} ui-variant--${variant}" id="${node.id}" data-component="${definition.id}" data-component-version="${definition.version}">${contentByRenderer[definition.renderer]()}</section>`
}

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
  Match.when({ kind: "component" }, (value) => renderComponentNode(value, new Map([[value.id, value]]), context, new Set())),
  Match.exhaustive,
)

export const renderUiBlock = (block: UiBlockType, context: UiCompileContext): string => render(renderBlockHtml(block, context))

export const renderUiPage = (page: UiPage, context: UiCompileContext): string => {
  const nodes = new Map(page.blocks.flatMap((block): ReadonlyArray<readonly [string, UiComponentNodeType]> => block.kind === "component" ? [[block.id, block]] : []))
  const referenced = new Set([...nodes.values()].flatMap((node) => node.children))
  const manifestRoots = page.manifest.slots.flatMap((slot) => {
    const node = nodes.get(slot.id)
    return node === undefined ? [] : [node]
  })
  const roots = manifestRoots.length > 0 ? manifestRoots : [...nodes.values()].filter((node) => !referenced.has(node.id))
  const structured = roots.length === 0 ? page.blocks.map((block) => renderBlockHtml(block, context)) : roots.map((node) => renderComponentNode(node, nodes, context, new Set()))
  return render(html`${context.theme === undefined ? raw("") : html`<link rel="stylesheet" href="${context.theme.href}" />`}<div class="ui-page ui-page--${page.manifest.archetype}" data-recipe="${page.manifest.recipe.id}" data-ui-theme="${context.theme?.id ?? "default"}">${join(structured)}</div>`)
}
