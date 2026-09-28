import { Schema } from "effect"

export const DesignSystemRef = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
})
export type DesignSystemRef = typeof DesignSystemRef.Type

export const RecipeRef = Schema.Struct({
  id: Schema.Literals(["landing.hero-grid", "app.workspace", "doc.architecture"]),
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
    scale: Schema.Literals(["compact", "standard", "spacious"]),
  }),
  density: Schema.Literals(["compact", "standard", "comfortable"]),
  radius: Schema.Literals(["sharp", "soft", "round"]),
  shadow: Schema.Literals(["none", "subtle", "layered"]),
  motion: Schema.Literals(["none", "reduced", "standard"]),
})
export type DesignTokensV1 = typeof DesignTokensV1.Type

/**
 * A deliberately small visual intent. Models choose these semantic controls;
 * the trusted renderer derives the full shade ramp and CSS variables. This is
 * much cheaper to stream than a bag of CSS values and keeps every component
 * on the same visual grammar.
 */
export const ThemeIntent = Schema.Struct({
  mode: Schema.Literals(["dark", "light"]),
  accent: Schema.String,
  neutral: Schema.String,
  positive: Schema.String,
  warning: Schema.String,
  danger: Schema.String,
  contrast: Schema.Literals(["soft", "standard", "high"]),
  surface: Schema.Literals(["flat", "layered", "translucent"]),
  border: Schema.Literals(["none", "subtle", "strong"]),
  radius: Schema.Literals(["sharp", "soft", "round"]),
  shadow: Schema.Literals(["none", "subtle", "layered"]),
  typography: Schema.Literals(["system", "editorial", "geometric"]),
  typeScale: Schema.Literals(["compact", "standard", "spacious"]),
  density: Schema.Literals(["compact", "standard", "comfortable"]),
  motion: Schema.Literals(["none", "reduced", "standard"]),
})
export type ThemeIntent = typeof ThemeIntent.Type

export const ThemeDelta = Schema.Struct({
  mode: Schema.optional(ThemeIntent.fields.mode),
  accent: Schema.optional(Schema.String),
  neutral: Schema.optional(Schema.String),
  positive: Schema.optional(Schema.String),
  warning: Schema.optional(Schema.String),
  danger: Schema.optional(Schema.String),
  contrast: Schema.optional(ThemeIntent.fields.contrast),
  surface: Schema.optional(ThemeIntent.fields.surface),
  border: Schema.optional(ThemeIntent.fields.border),
  radius: Schema.optional(ThemeIntent.fields.radius),
  shadow: Schema.optional(ThemeIntent.fields.shadow),
  typography: Schema.optional(ThemeIntent.fields.typography),
  typeScale: Schema.optional(ThemeIntent.fields.typeScale),
  density: Schema.optional(ThemeIntent.fields.density),
  motion: Schema.optional(ThemeIntent.fields.motion),
})
export type ThemeDelta = typeof ThemeDelta.Type

export const DesignTokensV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  id: Schema.String,
  version: Schema.String,
  theme: ThemeIntent,
  typography: Schema.Struct({ mono: Schema.Literal("mono") }),
  layout: Schema.Struct({
    contentWidth: Schema.Literals(["narrow", "standard", "wide"]),
    grid: Schema.Literals(["compact", "standard", "editorial"]),
  }),
})
export type DesignTokensV2 = typeof DesignTokensV2.Type

export const DesignTokens = Schema.Union([DesignTokensV1, DesignTokensV2])
export type DesignTokens = typeof DesignTokens.Type

export const ThemeDefinition = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  designSystem: DesignSystemRef,
  intent: ThemeIntent,
  status: Schema.Literals(["workspace", "promoted", "deprecated"]),
  fingerprint: Schema.String,
  createdAt: Schema.Number,
})
export type ThemeDefinition = typeof ThemeDefinition.Type

export const RegisteredAsset = Schema.Struct({
  id: Schema.String,
  src: Schema.String,
  alt: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})
export type RegisteredAsset = typeof RegisteredAsset.Type
