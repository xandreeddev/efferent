import { Either } from "effect"
import { themeIntentFromTokens } from "@xandreed/ui-agent"
import type { DesignTokensType, ThemeIntentType } from "@xandreed/ui-agent"

const COLOR = /^#[0-9a-f]{6}$/i
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/

const FONT_STACKS: Readonly<Record<string, string>> = {
  system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  editorial: "Georgia, 'Times New Roman', serif",
  geometric: "Avenir, Montserrat, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
}

const font = (id: string): string | undefined => FONT_STACKS[id]

export const validateThemeIntent = (theme: ThemeIntentType): ReadonlyArray<string> => [
  ...(["accent", "neutral", "positive", "warning", "danger"] as const).flatMap((name) => COLOR.test(theme[name]) ? [] : [`theme.${name} must be a six-digit hex color`]),
]

export const validateDesignTokens = (tokens: DesignTokensType): ReadonlyArray<string> => [
  ...(tokens.schemaVersion === 1 ? Object.entries(tokens.colors).flatMap(([name, value]) => COLOR.test(value) ? [] : [`colors.${name} must be a six-digit hex color`]) : validateThemeIntent(tokens.theme)),
  ...(SAFE_ID.test(tokens.id) ? [] : ["id must be kebab-case"]),
  ...(tokens.schemaVersion === 1 && font(tokens.typography.display) === undefined ? ["typography.display must name a registered font"] : []),
  ...(tokens.schemaVersion === 1 && font(tokens.typography.body) === undefined ? ["typography.body must name a registered font"] : []),
  ...(tokens.schemaVersion === 1 && font(tokens.typography.mono) === undefined ? ["typography.mono must name a registered font"] : []),
]

const density = { compact: "0.82", standard: "1", comfortable: "1.18" } as const
const radius = { sharp: "2px", soft: "10px", round: "20px" } as const
const shadow = { none: "none", subtle: "0 12px 34px rgb(0 0 0 / 0.16)", layered: "0 24px 70px rgb(0 0 0 / 0.3)" } as const
const motion = { none: "0ms", reduced: "80ms", standard: "180ms" } as const
const typeScale = { compact: "0.94", standard: "1", spacious: "1.08" } as const

const borderWidth = { none: "0px", subtle: "1px", strong: "2px" } as const
const contrastText = { soft: "82%", standard: "91%", high: "98%" } as const
const surfaceMix = { flat: "8%", layered: "14%", translucent: "10%" } as const
const contentWidth = { narrow: "760px", standard: "1080px", wide: "1320px" } as const

const themeRule = (theme: ThemeIntentType, selector: string, width = "1080px"): string => {
  const dark = theme.mode === "dark"
  const pageMix = dark ? "12%" : "96%"
  const raisedMix = dark ? "22%" : "88%"
  const foreground = dark ? "#ffffff" : "#000000"
  const background = dark ? "#000000" : "#ffffff"
  return `${selector}{
--ui-accent-seed:${theme.accent};--ui-neutral-seed:${theme.neutral};--ui-success-seed:${theme.positive};--ui-warning-seed:${theme.warning};--ui-danger-seed:${theme.danger};
--ui-accent-50:color-mix(in oklch,var(--ui-accent-seed) 12%,${background});--ui-accent-100:color-mix(in oklch,var(--ui-accent-seed) 24%,${background});--ui-accent-300:color-mix(in oklch,var(--ui-accent-seed) 55%,${background});--ui-accent-500:var(--ui-accent-seed);--ui-accent-700:color-mix(in oklch,var(--ui-accent-seed) 70%,${foreground});--ui-accent-900:color-mix(in oklch,var(--ui-accent-seed) 34%,${foreground});
--ui-page:color-mix(in oklch,var(--ui-neutral-seed) ${pageMix},${background});--ui-surface:color-mix(in oklch,var(--ui-neutral-seed) ${surfaceMix[theme.surface]},var(--ui-page));--ui-raised:color-mix(in oklch,var(--ui-neutral-seed) ${raisedMix},var(--ui-page));
--ui-text:color-mix(in oklch,${foreground} ${contrastText[theme.contrast]},var(--ui-page));--ui-muted:color-mix(in oklch,var(--ui-text) 62%,var(--ui-page));--ui-line:color-mix(in oklch,var(--ui-text) ${theme.border === "strong" ? "28%" : "16%"},transparent);
--ui-accent:var(--ui-accent-500);--ui-success:var(--ui-success-seed);--ui-warning:var(--ui-warning-seed);--ui-danger:var(--ui-danger-seed);
--ui-font-display:${font(theme.typography)};--ui-font-body:${font(theme.typography === "editorial" ? "system" : theme.typography)};--ui-font-mono:${font("mono")};--ui-type-scale:${typeScale[theme.typeScale]};
--ui-density:${density[theme.density]};--ui-radius:${radius[theme.radius]};--ui-shadow:${shadow[theme.shadow]};--ui-motion:${motion[theme.motion]};--ui-border-width:${borderWidth[theme.border]};--ui-content-width:${width};
--ui-space-1:calc(4px * var(--ui-density));--ui-space-2:calc(8px * var(--ui-density));--ui-space-3:calc(12px * var(--ui-density));--ui-space-4:calc(16px * var(--ui-density));--ui-space-6:calc(24px * var(--ui-density));--ui-space-8:calc(32px * var(--ui-density));--ui-space-12:calc(48px * var(--ui-density));
}`
}

export const compileThemeCss = (theme: ThemeIntentType, selector: string): Either.Either<string, ReadonlyArray<string>> => {
  const findings = [
    ...validateThemeIntent(theme),
    ...(/^:root$|^\[data-ui-theme="[a-z0-9-]+"\]$/.test(selector) ? [] : ["theme selector is invalid"]),
  ]
  return findings.length > 0 ? Either.left(findings) : Either.right(themeRule(theme, selector))
}

export const compileDesignTokenCss = (tokens: DesignTokensType): Either.Either<string, ReadonlyArray<string>> => {
  const findings = validateDesignTokens(tokens)
  if (findings.length > 0) return Either.left(findings)
  if (tokens.schemaVersion === 2) return Either.right(themeRule(tokens.theme, ":root", contentWidth[tokens.layout.contentWidth]))
  return Either.right(`:root{
--ui-page:${tokens.colors.page};--ui-surface:${tokens.colors.surface};--ui-raised:${tokens.colors.raised};--ui-line:${tokens.colors.line};
--ui-text:${tokens.colors.text};--ui-muted:${tokens.colors.muted};--ui-accent:${tokens.colors.accent};--ui-success:${tokens.colors.success};
--ui-warning:${tokens.colors.warning};--ui-danger:${tokens.colors.danger};--ui-font-display:${font(tokens.typography.display)};
--ui-font-body:${font(tokens.typography.body)};--ui-font-mono:${font(tokens.typography.mono)};--ui-type-scale:${typeScale[tokens.typography.scale]};
--ui-density:${density[tokens.density]};--ui-radius:${radius[tokens.radius]};--ui-shadow:${shadow[tokens.shadow]};--ui-motion:${motion[tokens.motion]};}`)
}
