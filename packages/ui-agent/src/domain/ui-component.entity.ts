import { Schema } from "effect"

export const UiPropKind = Schema.Literal(
  "string",
  "number",
  "boolean",
  "string-array",
  "item-array",
  "record",
)
export type UiPropKind = typeof UiPropKind.Type

export const UiPropDefinition = Schema.Struct({
  name: Schema.String,
  kind: UiPropKind,
  required: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
})
export type UiPropDefinition = typeof UiPropDefinition.Type

export const UiTemplateBinding = Schema.Union(
  Schema.Struct({ source: Schema.Literal("literal"), value: Schema.String }),
  Schema.Struct({ source: Schema.Literal("prop"), value: Schema.String }),
)
export type UiTemplateBinding = typeof UiTemplateBinding.Type

export const UiTemplateElement = Schema.Struct({
  id: Schema.String,
  tag: Schema.Literal("article", "aside", "div", "header", "li", "nav", "p", "section", "small", "span", "strong", "ul"),
  role: Schema.Literal("root", "header", "body", "items", "item", "meta", "actions", "media", "footer"),
  text: Schema.optional(UiTemplateBinding),
  children: Schema.Array(Schema.String),
})
export type UiTemplateElement = typeof UiTemplateElement.Type

/** A flat, bounded template AST. It has no source-code or arbitrary attribute
 * escape hatch: the Surface compiler owns tags, classes and behavior. */
export const UiTemplateAst = Schema.Struct({
  root: Schema.String,
  elements: Schema.Array(UiTemplateElement),
})
export type UiTemplateAst = typeof UiTemplateAst.Type

export const UiComponentRenderer = Schema.Literal(
  "layout",
  "navigation",
  "hero",
  "text",
  "action",
  "cards",
  "stats",
  "form",
  "table",
  "tabs",
  "callout",
  "timeline",
  "code",
  "cta",
  "media",
  "feedback",
  "template",
)
export type UiComponentRenderer = typeof UiComponentRenderer.Type

export const UiComponentDefinition = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  category: Schema.Literal("layout", "navigation", "form", "application", "marketing", "document", "feedback", "primitive"),
  description: Schema.String,
  renderer: UiComponentRenderer,
  variants: Schema.Array(Schema.String),
  props: Schema.Array(UiPropDefinition),
  slots: Schema.Array(Schema.String),
  template: Schema.optional(UiTemplateAst),
  status: Schema.Literal("core", "workspace", "candidate", "deprecated"),
  fingerprint: Schema.optional(Schema.String),
  replacedBy: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})
export type UiComponentDefinition = typeof UiComponentDefinition.Type

export const UiBehavior = Schema.Union(
  Schema.Struct({ type: Schema.Literal("action"), capability: Schema.String, label: Schema.String, variant: Schema.optional(Schema.Literal("primary", "secondary", "danger")) }),
  Schema.Struct({ type: Schema.Literal("toggle"), target: Schema.String, label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("select"), state: Schema.String, initial: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("disclosure"), target: Schema.String, expanded: Schema.optional(Schema.Boolean) }),
)
export type UiBehavior = typeof UiBehavior.Type

/** The streamable component node. Child ids form a flat adjacency list so a
 * parent can paint before all of its children have arrived. */
export const UiComponentNode = Schema.Struct({
  kind: Schema.Literal("component"),
  id: Schema.String,
  component: Schema.String,
  variant: Schema.optional(Schema.String),
  props: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  children: Schema.Array(Schema.String),
  behaviors: Schema.optional(Schema.Array(UiBehavior)),
})
export type UiComponentNode = typeof UiComponentNode.Type

export const UiComponentUsage = Schema.Struct({
  componentId: Schema.String,
  pageId: Schema.String,
  intent: Schema.String,
  renderedAt: Schema.Number,
})
export type UiComponentUsage = typeof UiComponentUsage.Type

export const UiComponentAdmission = Schema.Struct({
  definition: UiComponentDefinition,
  disposition: Schema.Literal("reused", "variant", "admitted"),
  canonicalId: Schema.String,
  similarity: Schema.Number,
})
export type UiComponentAdmission = typeof UiComponentAdmission.Type

export const UiSurfaceBlueprint = Schema.Struct({
  pageId: Schema.String,
  archetype: Schema.Literal("landing", "application", "document"),
  designDirection: Schema.String,
  catalogVersion: Schema.String,
  sections: Schema.Array(Schema.Struct({ id: Schema.String, purpose: Schema.String, priority: Schema.Literal("critical", "standard", "supporting") })),
})
export type UiSurfaceBlueprint = typeof UiSurfaceBlueprint.Type

export const UiStreamRecord = Schema.Union(
  Schema.Struct({ type: Schema.Literal("surface"), surface: UiSurfaceBlueprint, at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("node"), pageId: Schema.String, node: UiComponentNode, at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("prop"), pageId: Schema.String, nodeId: Schema.String, key: Schema.String, value: Schema.Unknown, at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("commit"), pageId: Schema.String, nodeIds: Schema.Array(Schema.String), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("complete"), pageId: Schema.String, at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("error"), pageId: Schema.optional(Schema.String), stage: Schema.String, code: Schema.String, message: Schema.String, at: Schema.Number }),
)
export type UiStreamRecord = typeof UiStreamRecord.Type
