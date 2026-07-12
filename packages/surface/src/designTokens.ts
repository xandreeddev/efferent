import { Either } from "effect"
import type { DesignTokensV1Type } from "@xandreed/ui-agent"

const COLOR = /^#[0-9a-f]{6}$/i
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/

const FONT_STACKS: Readonly<Record<string, string>> = {
  system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  editorial: "Georgia, 'Times New Roman', serif",
  geometric: "Avenir, Montserrat, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
}

const font = (id: string): string | undefined => FONT_STACKS[id]

export const validateDesignTokens = (tokens: DesignTokensV1Type): ReadonlyArray<string> => [
  ...Object.entries(tokens.colors).flatMap(([name, value]) => COLOR.test(value) ? [] : [`colors.${name} must be a six-digit hex color`]),
  ...(SAFE_ID.test(tokens.id) ? [] : ["id must be kebab-case"]),
  ...(font(tokens.typography.display) === undefined ? ["typography.display must name a registered font"] : []),
  ...(font(tokens.typography.body) === undefined ? ["typography.body must name a registered font"] : []),
  ...(font(tokens.typography.mono) === undefined ? ["typography.mono must name a registered font"] : []),
]

const density = { compact: "0.82", standard: "1", comfortable: "1.18" } as const
const radius = { sharp: "2px", soft: "10px", round: "20px" } as const
const shadow = { none: "none", subtle: "0 12px 34px rgb(0 0 0 / 0.16)", layered: "0 24px 70px rgb(0 0 0 / 0.3)" } as const
const motion = { none: "0ms", reduced: "80ms", standard: "180ms" } as const
const typeScale = { compact: "0.94", standard: "1", spacious: "1.08" } as const

export const compileDesignTokenCss = (tokens: DesignTokensV1Type): Either.Either<string, ReadonlyArray<string>> => {
  const findings = validateDesignTokens(tokens)
  if (findings.length > 0) return Either.left(findings)
  return Either.right(`:root{
--ui-page:${tokens.colors.page};--ui-surface:${tokens.colors.surface};--ui-raised:${tokens.colors.raised};--ui-line:${tokens.colors.line};
--ui-text:${tokens.colors.text};--ui-muted:${tokens.colors.muted};--ui-accent:${tokens.colors.accent};--ui-success:${tokens.colors.success};
--ui-warning:${tokens.colors.warning};--ui-danger:${tokens.colors.danger};--ui-font-display:${font(tokens.typography.display)};
--ui-font-body:${font(tokens.typography.body)};--ui-font-mono:${font(tokens.typography.mono)};--ui-type-scale:${typeScale[tokens.typography.scale]};
--ui-density:${density[tokens.density]};--ui-radius:${radius[tokens.radius]};--ui-shadow:${shadow[tokens.shadow]};--ui-motion:${motion[tokens.motion]};}`)
}
