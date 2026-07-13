import type { UiComponentDefinition, UiComponentRenderer, UiPropDefinition } from "./ui-component.entity.js"

const string = (name: string, required = false): UiPropDefinition => ({ name, kind: "string", required })
const number = (name: string, required = false): UiPropDefinition => ({ name, kind: "number", required })
const boolean = (name: string, required = false): UiPropDefinition => ({ name, kind: "boolean", required })
const strings = (name: string, required = false): UiPropDefinition => ({ name, kind: "string-array", required })
const items = (name: string, required = false): UiPropDefinition => ({ name, kind: "item-array", required })
const record = (name: string, required = false): UiPropDefinition => ({ name, kind: "record", required })

type ComponentSeed = {
  readonly id: string
  readonly category: UiComponentDefinition["category"]
  readonly renderer: UiComponentRenderer
  readonly description: string
  readonly variants?: ReadonlyArray<string>
  readonly props?: ReadonlyArray<UiPropDefinition>
  readonly slots?: ReadonlyArray<string>
}

const component = (seed: ComponentSeed): UiComponentDefinition => ({
  id: seed.id,
  version: "2.0.0",
  category: seed.category,
  description: seed.description,
  renderer: seed.renderer,
  variants: [...(seed.variants ?? [])],
  props: [...(seed.props ?? [])],
  slots: [...(seed.slots ?? [])],
  status: "core",
  createdAt: 0,
})

const layout = [
  ["layout.container", "Bounded responsive page container", ["narrow", "standard", "wide"]],
  ["layout.section", "Semantic vertical page section", ["plain", "surface", "accent"]],
  ["layout.stack", "Vertical content stack", ["compact", "standard", "spacious"]],
  ["layout.cluster", "Wrapping horizontal cluster", ["start", "center", "between"]],
  ["layout.grid", "Responsive grid", ["two", "three", "four", "auto"]],
  ["layout.split", "Responsive two-pane split", ["equal", "content-media", "media-content"]],
  ["layout.sidebar", "Sidebar and main workspace", ["left", "right"]],
  ["layout.cover", "Viewport-height centered cover", ["center", "bottom"]],
  ["layout.reel", "Horizontal scrollable reel", ["cards", "media"]],
  ["layout.scroll-region", "Bounded application scroll region", ["vertical", "horizontal"]],
].map(([id, description, variants]) => component({ id: id as string, category: "layout", renderer: "layout", description: description as string, variants: variants as ReadonlyArray<string>, props: [string("title"), string("body")], slots: ["children"] }))

const navigation = [
  ["navigation.navbar", "Primary product navigation", ["minimal", "centered", "product"]],
  ["navigation.sidebar", "Application sidebar navigation", ["compact", "expanded"]],
  ["navigation.breadcrumbs", "Hierarchical breadcrumb trail", ["default"]],
  ["navigation.tabs", "Section tabs with local state", ["underline", "pills"]],
  ["navigation.pagination", "Paged result navigation", ["compact", "full"]],
  ["navigation.command-palette", "Searchable command surface", ["dialog", "inline"]],
  ["navigation.table-of-contents", "Document section navigation", ["rail", "inline"]],
].map(([id, description, variants]) => component({ id: id as string, category: "navigation", renderer: "navigation", description: description as string, variants: variants as ReadonlyArray<string>, props: [string("brand"), items("items", true), string("actionLabel")], slots: ["children"] }))

const primitives = [
  component({ id: "primitive.heading", category: "primitive", renderer: "text", description: "Semantic heading", variants: ["display", "section", "subsection"], props: [string("text", true), string("eyebrow")] }),
  component({ id: "primitive.text", category: "primitive", renderer: "text", description: "Body or supporting text", variants: ["body", "lede", "muted", "caption"], props: [string("text", true)] }),
  component({ id: "primitive.badge", category: "primitive", renderer: "feedback", description: "Compact status or category label", variants: ["neutral", "accent", "success", "warning", "danger"], props: [string("text", true)] }),
  component({ id: "primitive.avatar", category: "primitive", renderer: "media", description: "Person or organization avatar", variants: ["small", "medium", "large"], props: [string("label", true), string("assetId")] }),
  component({ id: "primitive.image", category: "primitive", renderer: "media", description: "Governed media asset", variants: ["landscape", "portrait", "square"], props: [string("assetId"), string("caption"), string("label")] }),
  component({ id: "primitive.metric", category: "primitive", renderer: "stats", description: "Single metric and supporting detail", variants: ["compact", "hero"], props: [string("value", true), string("label", true), string("detail")] }),
  component({ id: "primitive.progress", category: "primitive", renderer: "feedback", description: "Progress indicator", variants: ["bar", "steps"], props: [number("value", true), string("label")] }),
  component({ id: "action.button", category: "primitive", renderer: "action", description: "Capability-backed action button", variants: ["primary", "secondary", "danger", "ghost"], props: [string("label", true), string("capability")] }),
  component({ id: "action.button-group", category: "primitive", renderer: "action", description: "Related action group", variants: ["inline", "stacked"], props: [items("items", true)] }),
]

const forms = [
  ["form.search", "Search input and submit action", ["compact", "hero"]],
  ["form.contact", "Contact or lead form", ["compact", "detailed"]],
  ["form.filters", "Faceted filters", ["toolbar", "sidebar"]],
  ["form.settings", "Grouped settings editor", ["sections", "cards"]],
  ["form.combobox", "Searchable selection control", ["single", "multiple"]],
  ["form.checkbox-group", "Multiple boolean selections", ["list", "cards"]],
  ["form.radio-group", "Exclusive selection group", ["list", "cards"]],
  ["form.switch-group", "Compact preference toggles", ["list"]],
  ["form.file-drop", "File upload drop surface", ["compact", "large"]],
].map(([id, description, variants]) => component({ id: id as string, category: "form", renderer: "form", description: description as string, variants: variants as ReadonlyArray<string>, props: [string("title"), string("capability"), string("submitLabel"), items("fields", true)] }))

const application = [
  ["application.data-table", "Sortable structured data table", "table", ["comfortable", "compact"]],
  ["application.description-list", "Label and value details", "cards", ["single", "columns"]],
  ["application.result-list", "Search or discovery results", "cards", ["rows", "cards"]],
  ["application.dashboard", "Operational metric dashboard", "stats", ["overview", "dense"]],
  ["application.chart", "Token-colored data visualization", "stats", ["bar", "line", "donut", "sparkline"]],
  ["application.calendar", "Calendar or schedule view", "cards", ["month", "agenda"]],
  ["application.kanban", "Column-oriented work board", "cards", ["compact", "detailed"]],
  ["application.activity-feed", "Chronological activity stream", "timeline", ["compact", "detailed"]],
  ["application.inspector", "Object detail inspector", "cards", ["rail", "panel"]],
  ["application.empty-state", "Purposeful empty application state", "feedback", ["quiet", "action"]],
].map(([id, description, renderer, variants]) => component({ id: id as string, category: "application", renderer: renderer as UiComponentRenderer, description: description as string, variants: variants as ReadonlyArray<string>, props: [string("title"), string("body"), items("items"), items("columns"), items("rows"), string("empty"), string("value"), string("label")] }))

const marketing = [
  ["marketing.hero", "Product hero with concrete value proposition", "hero", ["split", "centered", "editorial"]],
  ["marketing.logo-cloud", "Customer or integration proof", "cards", ["row", "grid"]],
  ["marketing.feature-grid", "Product capabilities", "cards", ["cards", "bento", "editorial"]],
  ["marketing.bento", "Asymmetric feature composition", "cards", ["three", "five"]],
  ["marketing.pricing", "Pricing tier comparison", "cards", ["two", "three", "comparison"]],
  ["marketing.comparison", "Capability comparison", "table", ["table", "cards"]],
  ["marketing.testimonials", "Customer evidence", "cards", ["single", "grid"]],
  ["marketing.faq", "Frequently asked questions", "tabs", ["accordion", "split"]],
  ["marketing.steps", "Numbered workflow or onboarding", "timeline", ["vertical", "horizontal"]],
  ["marketing.gallery", "Product or editorial gallery", "media", ["grid", "reel"]],
  ["marketing.team", "People and roles", "cards", ["grid", "list"]],
  ["marketing.cta", "Focused conversion call to action", "cta", ["band", "card", "minimal"]],
].map(([id, description, renderer, variants]) => component({ id: id as string, category: "marketing", renderer: renderer as UiComponentRenderer, description: description as string, variants: variants as ReadonlyArray<string>, props: [string("eyebrow"), string("title"), string("lede"), string("body"), string("assetId"), items("items"), items("actions"), items("columns"), items("rows")] }))

const documents = [
  ["document.prose", "Long-form document content", "text", ["standard", "editorial"]],
  ["document.callout", "Important document note", "callout", ["info", "success", "warning", "danger"]],
  ["document.code", "Syntax-labelled code sample", "code", ["block", "terminal"]],
  ["document.api-reference", "API operation reference", "code", ["endpoint", "schema"]],
  ["document.architecture", "Service and dependency architecture", "cards", ["graph", "layers"]],
  ["document.flow", "Process or data flow", "timeline", ["horizontal", "vertical"]],
  ["document.sequence", "Ordered actor interactions", "timeline", ["lanes", "compact"]],
  ["document.decisions", "Architecture decision records", "cards", ["grid", "list"]],
  ["document.changelog", "Versioned product changes", "timeline", ["timeline", "releases"]],
  ["document.quote", "Quoted evidence or principle", "text", ["pullquote", "testimonial"]],
].map(([id, description, renderer, variants]) => component({ id: id as string, category: "document", renderer: renderer as UiComponentRenderer, description: description as string, variants: variants as ReadonlyArray<string>, props: [string("title"), string("body"), strings("paragraphs"), string("language"), string("code"), string("tone"), items("items"), record("graph")] }))

const feedback = [
  ["feedback.alert", "Inline contextual alert", ["info", "success", "warning", "danger"]],
  ["feedback.toast", "Transient action feedback", ["info", "success", "warning", "danger"]],
  ["feedback.status", "Compact system status", ["neutral", "success", "warning", "danger"]],
  ["feedback.empty-state", "Empty collection guidance", ["quiet", "action"]],
  ["feedback.skeleton", "Honest loading placeholder", ["text", "cards", "table"]],
  ["feedback.error", "Recoverable error explanation", ["inline", "page"]],
].map(([id, description, variants]) => component({ id: id as string, category: "feedback", renderer: "feedback", description: description as string, variants: variants as ReadonlyArray<string>, props: [string("title"), string("body"), string("label"), string("capability"), number("value"), boolean("busy")] }))

export const CORE_UI_COMPONENTS: ReadonlyArray<UiComponentDefinition> = [
  ...layout,
  ...navigation,
  ...primitives,
  ...forms,
  ...application,
  ...marketing,
  ...documents,
  ...feedback,
]
