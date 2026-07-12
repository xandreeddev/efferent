import { Schema } from "effect"
import { DesignSystemRef, RecipeRef } from "./design-system.entity.js"

const ActionRef = Schema.Struct({
  capability: Schema.String,
  label: Schema.String,
  variant: Schema.optional(Schema.Literal("primary", "secondary", "danger")),
})

const Link = Schema.Struct({ label: Schema.String, target: Schema.String })
const Stat = Schema.Struct({ label: Schema.String, value: Schema.String, detail: Schema.optional(Schema.String) })
const Card = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  badge: Schema.optional(Schema.String),
  assetId: Schema.optional(Schema.String),
})
const Field = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  kind: Schema.Literal("text", "email", "number", "select", "textarea", "checkbox"),
  placeholder: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  required: Schema.optional(Schema.Boolean),
})
const TableColumn = Schema.Struct({ key: Schema.String, label: Schema.String })
const TableRow = Schema.Record({ key: Schema.String, value: Schema.String })

export const ArchitectureNode = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literal("user", "service", "module", "database", "queue", "external"),
  group: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
})
export type ArchitectureNode = typeof ArchitectureNode.Type

export const ArchitectureEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  label: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literal("sync", "async", "data", "dependency")),
})
export type ArchitectureEdge = typeof ArchitectureEdge.Type

export const ArchitectureGraph = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  direction: Schema.Literal("LR", "TB"),
  groups: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))),
  nodes: Schema.Array(ArchitectureNode),
  edges: Schema.Array(ArchitectureEdge),
})
export type ArchitectureGraph = typeof ArchitectureGraph.Type

export const UiBlock = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("hero"), id: Schema.String, eyebrow: Schema.optional(Schema.String), title: Schema.String, lede: Schema.String, actions: Schema.optional(Schema.Array(ActionRef)), assetId: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("navigation"), id: Schema.String, brand: Schema.String, links: Schema.Array(Link), action: Schema.optional(ActionRef) }),
  Schema.Struct({ kind: Schema.Literal("prose"), id: Schema.String, title: Schema.optional(Schema.String), paragraphs: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("media"), id: Schema.String, assetId: Schema.String, caption: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("feature-grid"), id: Schema.String, title: Schema.optional(Schema.String), items: Schema.Array(Card) }),
  Schema.Struct({ kind: Schema.Literal("cards"), id: Schema.String, title: Schema.optional(Schema.String), items: Schema.Array(Card) }),
  Schema.Struct({ kind: Schema.Literal("stats"), id: Schema.String, title: Schema.optional(Schema.String), items: Schema.Array(Stat) }),
  Schema.Struct({ kind: Schema.Literal("cta"), id: Schema.String, title: Schema.String, body: Schema.String, actions: Schema.Array(ActionRef) }),
  Schema.Struct({ kind: Schema.Literal("form"), id: Schema.String, title: Schema.String, capability: Schema.String, submitLabel: Schema.String, fields: Schema.Array(Field) }),
  Schema.Struct({ kind: Schema.Literal("data-table"), id: Schema.String, title: Schema.String, columns: Schema.Array(TableColumn), rows: Schema.Array(TableRow), empty: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tabs"), id: Schema.String, title: Schema.optional(Schema.String), tabs: Schema.Array(Schema.Struct({ label: Schema.String, body: Schema.String })) }),
  Schema.Struct({ kind: Schema.Literal("code"), id: Schema.String, title: Schema.optional(Schema.String), language: Schema.String, code: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("callout"), id: Schema.String, tone: Schema.Literal("info", "success", "warning", "danger"), title: Schema.String, body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("timeline"), id: Schema.String, title: Schema.String, items: Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String })) }),
  Schema.Struct({ kind: Schema.Literal("decisions"), id: Schema.String, title: Schema.String, items: Schema.Array(Schema.Struct({ decision: Schema.String, rationale: Schema.String, status: Schema.Literal("proposed", "accepted", "deprecated") })) }),
  Schema.Struct({ kind: Schema.Literal("architecture"), id: Schema.String, graph: ArchitectureGraph }),
)
export type UiBlock = typeof UiBlock.Type

export const PageSlot = Schema.Struct({
  id: Schema.String,
  blockKind: Schema.String,
  importance: Schema.Literal("critical", "standard", "supporting"),
})
export type PageSlot = typeof PageSlot.Type

export const PageManifest = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  archetype: Schema.Literal("landing", "application", "document"),
  recipe: RecipeRef,
  designSystem: DesignSystemRef,
  slots: Schema.Array(PageSlot),
})
export type PageManifest = typeof PageManifest.Type

export const UiPageEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("page_opened"), page: PageManifest, blocks: Schema.Array(UiBlock), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("blocks_upserted"), pageId: Schema.String, blocks: Schema.Array(UiBlock), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("page_completed"), pageId: Schema.String, at: Schema.Number }),
)
export type UiPageEvent = typeof UiPageEvent.Type

export interface UiPage {
  readonly manifest: PageManifest
  readonly blocks: ReadonlyArray<UiBlock>
  readonly complete: boolean
}
