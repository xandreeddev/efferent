import type { PageManifestType, UiBlockType } from "./index.js"

const designSystem = { id: "efferent-canvas", version: "1.0.0" } as const

export const landingReference: { readonly page: PageManifestType; readonly blocks: ReadonlyArray<UiBlockType> } = {
  page: {
    id: "signal-landing", title: "Signal", archetype: "landing",
    recipe: { id: "landing.hero-grid", version: "1.0.0" }, designSystem,
    slots: [
      { id: "hero", blockKind: "hero", importance: "critical" },
      { id: "proof", blockKind: "stats", importance: "standard" },
      { id: "features", blockKind: "feature-grid", importance: "standard" },
      { id: "process", blockKind: "timeline", importance: "supporting" },
      { id: "cta", blockKind: "cta", importance: "critical" },
    ],
  },
  blocks: [
    { kind: "hero", id: "hero", eyebrow: "Operational intelligence", title: "See the signal before it becomes noise.", lede: "A focused command surface for teams that need decisions, not another dashboard.", actions: [{ capability: "canvas.request-demo", label: "Request a demo", variant: "primary" }] },
    { kind: "stats", id: "proof", items: [{ label: "faster triage", value: "42%" }, { label: "signals resolved", value: "18k" }, { label: "median setup", value: "12m" }] },
    { kind: "feature-grid", id: "features", title: "One system, three decisive moves", items: [{ title: "Detect", body: "Surface material changes without alert fatigue." }, { title: "Decide", body: "Put evidence and ownership in the same view." }, { title: "Act", body: "Run governed workflows from registered actions." }] },
    { kind: "timeline", id: "process", title: "From signal to resolution", items: [{ title: "Connect", body: "Choose approved sources." }, { title: "Shape", body: "Apply your operating model." }, { title: "Resolve", body: "Close the loop with evidence." }] },
    { kind: "cta", id: "cta", title: "Build a calmer operating system.", body: "Start with a governed workspace tailored to your team.", actions: [{ capability: "canvas.request-demo", label: "See it in action", variant: "primary" }] },
  ],
}

export const applicationReference: { readonly page: PageManifestType; readonly blocks: ReadonlyArray<UiBlockType> } = {
  page: {
    id: "issue-workspace", title: "Issue workspace", archetype: "application",
    recipe: { id: "app.workspace", version: "1.0.0" }, designSystem,
    slots: [
      { id: "navigation", blockKind: "navigation", importance: "critical" },
      { id: "health", blockKind: "stats", importance: "standard" },
      { id: "create-issue", blockKind: "form", importance: "critical" },
      { id: "issues", blockKind: "data-table", importance: "critical" },
      { id: "guidance", blockKind: "callout", importance: "supporting" },
    ],
  },
  blocks: [
    { kind: "navigation", id: "navigation", brand: "Issues", links: [{ label: "Backlog", target: "issues" }, { label: "New issue", target: "create-issue" }] },
    { kind: "stats", id: "health", items: [{ label: "open", value: "18" }, { label: "blocked", value: "3" }, { label: "closed this week", value: "27" }] },
    { kind: "form", id: "create-issue", title: "Create issue", capability: "canvas.acknowledge", submitLabel: "Create", fields: [{ name: "title", label: "Title", kind: "text", required: true }, { name: "priority", label: "Priority", kind: "select", options: ["Low", "Medium", "High"] }] },
    { kind: "data-table", id: "issues", title: "Active issues", columns: [{ key: "id", label: "ID" }, { key: "title", label: "Issue" }, { key: "state", label: "State" }], rows: [{ id: "ISS-42", title: "Retry policy hides root cause", state: "In progress" }, { id: "ISS-43", title: "Document adapter timeout", state: "Ready" }], empty: "No active issues." },
    { kind: "callout", id: "guidance", tone: "info", title: "Triage rule", body: "Every blocked issue needs an owner and a next decision." },
  ],
}

export const architectureReference: { readonly page: PageManifestType; readonly blocks: ReadonlyArray<UiBlockType> } = {
  page: {
    id: "ports-and-adapters", title: "Ports and adapters", archetype: "document",
    recipe: { id: "doc.architecture", version: "1.0.0" }, designSystem,
    slots: [
      { id: "hero", blockKind: "hero", importance: "critical" },
      { id: "overview", blockKind: "prose", importance: "critical" },
      { id: "system-map", blockKind: "architecture", importance: "critical" },
      { id: "decisions", blockKind: "decisions", importance: "standard" },
      { id: "example", blockKind: "code", importance: "supporting" },
    ],
  },
  blocks: [
    { kind: "hero", id: "hero", eyebrow: "Architecture note", title: "Keep policy inward and effects at the edge.", lede: "A reference topology for Effect-native ports and adapters." },
    { kind: "prose", id: "overview", title: "The dependency rule", paragraphs: ["Domain entities and functions express policy without runtime imports.", "Use cases depend on ports. Adapters translate external failures into typed Effects and are assembled as Layers."] },
    { kind: "architecture", id: "system-map", graph: { title: "Issue workflow topology", description: "The HTTP adapter calls an Effect use case, which depends on repository and notification ports implemented at the edge.", direction: "LR", nodes: [{ id: "http-adapter", label: "HTTP adapter", kind: "external" }, { id: "create-usecase", label: "Create issue", kind: "service" }, { id: "issue-entity", label: "Issue entity", kind: "module" }, { id: "repository", label: "Issue repository", kind: "database" }, { id: "notifications", label: "Notification port", kind: "queue" }], edges: [{ from: "http-adapter", to: "create-usecase", label: "decoded command", kind: "sync" }, { from: "create-usecase", to: "issue-entity", label: "domain policy", kind: "dependency" }, { from: "create-usecase", to: "repository", label: "persist", kind: "data" }, { from: "create-usecase", to: "notifications", label: "publish", kind: "async" }] } },
    { kind: "decisions", id: "decisions", title: "Decisions", items: [{ decision: "Schema constants define entities", rationale: "Runtime decoding and static types share one contract.", status: "accepted" }, { decision: "Adapters provide Layers", rationale: "Composition stays explicit and testable.", status: "accepted" }] },
    { kind: "code", id: "example", title: "Composition root", language: "typescript", code: "program.pipe(Effect.provide(AppLive))" },
  ],
}
