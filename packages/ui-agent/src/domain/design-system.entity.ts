import { Schema } from "effect"

export const DesignSystemRef = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
})
export type DesignSystemRef = typeof DesignSystemRef.Type

export const RecipeRef = Schema.Struct({
  id: Schema.Literal("landing.hero-grid", "app.workspace", "doc.architecture"),
  version: Schema.String,
})
export type RecipeRef = typeof RecipeRef.Type

export const DesignTokensV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  version: Schema.String,
  colors: Schema.Struct({
    page: Schema.String,
    surface: Schema.String,
    raised: Schema.String,
    line: Schema.String,
    text: Schema.String,
    muted: Schema.String,
    accent: Schema.String,
    success: Schema.String,
    warning: Schema.String,
    danger: Schema.String,
  }),
  typography: Schema.Struct({
    display: Schema.String,
    body: Schema.String,
    mono: Schema.String,
    scale: Schema.Literal("compact", "standard", "spacious"),
  }),
  density: Schema.Literal("compact", "standard", "comfortable"),
  radius: Schema.Literal("sharp", "soft", "round"),
  shadow: Schema.Literal("none", "subtle", "layered"),
  motion: Schema.Literal("none", "reduced", "standard"),
})
export type DesignTokensV1 = typeof DesignTokensV1.Type

export const RegisteredAsset = Schema.Struct({
  id: Schema.String,
  src: Schema.String,
  alt: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})
export type RegisteredAsset = typeof RegisteredAsset.Type
