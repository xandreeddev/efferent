import type { DesignTokens, ThemeDelta, ThemeIntent } from "./design-system.entity.js"

const hash = (value: string): string => value.split("").reduce((state, character) => Math.imul((state ^ character.charCodeAt(0)) >>> 0, 16777619) >>> 0, 2166136261).toString(16).padStart(8, "0")
const COLOR = /^#[0-9a-f]{6}$/i

const legacyTheme = (tokens: Extract<DesignTokens, { readonly schemaVersion: 1 }>): ThemeIntent => ({
  mode: tokens.colors.page.toLowerCase() < "#888888" ? "dark" : "light",
  accent: tokens.colors.accent,
  neutral: tokens.colors.surface,
  positive: tokens.colors.success,
  warning: tokens.colors.warning,
  danger: tokens.colors.danger,
  contrast: "standard",
  surface: tokens.shadow === "none" ? "flat" : "layered",
  border: "subtle",
  radius: tokens.radius,
  shadow: tokens.shadow,
  typography: tokens.typography.display === "editorial" ? "editorial" : tokens.typography.display === "geometric" ? "geometric" : "system",
  typeScale: tokens.typography.scale,
  density: tokens.density,
  motion: tokens.motion,
})

export const themeIntentFromTokens = (tokens: DesignTokens): ThemeIntent => tokens.schemaVersion === 2 ? tokens.theme : legacyTheme(tokens)

export const applyThemeDelta = (theme: ThemeIntent, delta: ThemeDelta): ThemeIntent => ({
  mode: delta.mode ?? theme.mode,
  accent: delta.accent ?? theme.accent,
  neutral: delta.neutral ?? theme.neutral,
  positive: delta.positive ?? theme.positive,
  warning: delta.warning ?? theme.warning,
  danger: delta.danger ?? theme.danger,
  contrast: delta.contrast ?? theme.contrast,
  surface: delta.surface ?? theme.surface,
  border: delta.border ?? theme.border,
  radius: delta.radius ?? theme.radius,
  shadow: delta.shadow ?? theme.shadow,
  typography: delta.typography ?? theme.typography,
  typeScale: delta.typeScale ?? theme.typeScale,
  density: delta.density ?? theme.density,
  motion: delta.motion ?? theme.motion,
})

export const themeFingerprint = (theme: ThemeIntent): string => `theme-${hash(JSON.stringify(theme))}`

export const validateThemeIntent = (theme: ThemeIntent): ReadonlyArray<string> => (["accent", "neutral", "positive", "warning", "danger"] as const).flatMap((field) => COLOR.test(theme[field]) ? [] : [`theme.${field} must be a six-digit hex color`])
