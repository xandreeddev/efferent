import { html, join, raw, render, renderUiBlock } from "@xandreed/surface"
import type { UiCompileContext } from "@xandreed/surface"
import type { UiComponentDefinitionType, UiComponentNodeType } from "@xandreed/ui-agent"

export const renderShell = (csrfToken: string): string => render(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>efferent canvas</title><link rel="stylesheet" href="/assets/theme.css" /><link rel="stylesheet" href="/assets/app.css" />
<script src="/assets/htmx.min.js"></script><script src="/assets/htmx-ext-ws.js"></script><script defer src="/assets/alpine.min.js"></script></head>
<body><div id="ef-shell" class="ef-shell" hx-ext="ws" ws-connect="/ws"><header class="ef-topbar"><span class="ef-mark">▌efferent canvas</span>${raw(`<nav id="ef-tabs" class="ef-tabs-bar"></nav>`)}<a class="ef-catalog-link" href="/design-system">design system</a></header>
${raw(`<main id="ef-pages" class="ef-pages-host"><div id="ef-skeleton" class="ef-skeleton" hidden><div class="ef-skeleton-bar ef-skeleton-wide"></div><div class="ef-skeleton-bar"></div><div class="ef-skeleton-bar ef-skeleton-short"></div></div></main>`)}<footer class="ef-dockbar">${raw(`<div id="ef-status" class="ef-status-strip"></div>`)}
<form class="ef-ask" hx-post="/action/chat" hx-swap="none" autocomplete="off"><input type="hidden" name="csrf" value="${csrfToken}" /><input type="hidden" name="page" id="ef-viewing" value="" /><input class="ef-ask-input" name="prompt" placeholder="build me a page…" autofocus /><button class="ef-ask-send" type="submit">send</button></form></footer></div><script src="/assets/app.js"></script></body></html>`)

const fixtureValue = (name: string, kind: UiComponentDefinitionType["props"][number]["kind"]): unknown => {
  if (kind === "number") return 68
  if (kind === "boolean") return true
  if (kind === "string-array") return ["A concrete first paragraph.", "A supporting second paragraph."]
  if (kind === "item-array") return [
    { title: "Primary example", label: "Overview", body: "Useful content rendered through the trusted component contract.", detail: "Ready", value: "98%", target: "preview" },
    { title: "Secondary example", label: "Details", body: "The same anatomy responds to theme and density tokens.", detail: "Stable", value: "24ms", target: "preview" },
  ]
  if (kind === "record") return { summary: "Structured data" }
  const values: Readonly<Record<string, string>> = {
    title: "Component preview",
    text: "A semantic component driven by reusable design tokens.",
    body: "A semantic component driven by reusable design tokens.",
    lede: "Fast to stream, consistent to reuse, and safe to evolve.",
    eyebrow: "Design system",
    brand: "Efferent",
    label: "Continue",
    value: "98%",
    empty: "Nothing here yet.",
    submitLabel: "Apply",
    language: "ts",
    code: "Effect.succeed(\"typed UI\")",
    caption: "Trusted media",
  }
  return values[name] ?? "Example"
}

const fixtureNode = (definition: UiComponentDefinitionType, index: number): UiComponentNodeType => ({
  kind: "component",
  id: `catalog-preview-${index}`,
  component: definition.id,
  variant: definition.variants[0],
  props: Object.fromEntries(definition.props.map((prop) => [prop.name, fixtureValue(prop.name, prop.kind)])),
  children: [],
})

export const renderDesignSystemShell = (
  definitions: ReadonlyArray<UiComponentDefinitionType>,
  context: UiCompileContext,
  themes: ReadonlyArray<{ readonly id: string; readonly label: string }>,
): string => render(html`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Efferent design system</title><link rel="stylesheet" href="/assets/theme.css" /><link rel="stylesheet" href="/assets/catalog-themes.css" /><link rel="stylesheet" href="/assets/app.css" /></head>
<body data-ui-theme="${themes[0]?.id ?? "default"}"><main class="ef-catalog"><header class="ef-catalog-header"><div><a href="/">← canvas</a><p class="ui-eyebrow">evolutionary catalog</p><h1>Design system</h1><p>${definitions.length} canonical core and workspace components. Theme values never change component identity.</p></div><div class="ef-catalog-controls"><input id="ef-component-search" class="ef-ask-input" type="search" placeholder="Filter components…" /><label>Theme<select id="ef-theme-select" class="ef-ask-input">${join(themes.map((theme) => html`<option value="${theme.id}">${theme.label}</option>`))}</select></label></div></header>
<div class="ef-catalog-grid">${join(definitions.map((definition, index) => html`<article class="ef-catalog-card" data-component-card="${definition.id} ${definition.category} ${definition.description}"><header><div><strong>${definition.id}</strong><p>${definition.description}</p></div><span class="ui-badge">${definition.status}</span></header><small>${definition.category} · ${definition.renderer} · ${definition.version}</small><div class="ef-catalog-preview">${raw(renderUiBlock(fixtureNode(definition, index), context))}</div><footer>${definition.variants.length === 0 ? "default" : definition.variants.join(" · ")}</footer></article>`))}</div></main><script src="/assets/catalog.js"></script></body></html>`)
