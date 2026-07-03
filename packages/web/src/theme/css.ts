import { DEFAULT_THEME_NAME, webThemes } from "./themes.js"
import type { WebTokens } from "./tokens.js"

/**
 * Flatten a token tree to `--tok-*` custom-property pairs: nested record keys
 * join with dashes (`accent.conversation` → `--tok-accent-conversation`,
 * `match.word.bg` → `--tok-match-word-bg`). The names are the stable contract
 * `app.css` paints against — a theme switch swaps values, never names.
 */
export const flattenTokens = (t: WebTokens): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      out.push([`--tok-${path}`, node] as const)
      return
    }
    if (typeof node === "object" && node !== null) {
      for (const [k, v] of Object.entries(node)) walk(v, path === "" ? k : `${path}-${k}`)
    }
  }
  walk(t, "")
  return out
}

const block = (selector: string, tokens: WebTokens): string => {
  const vars = flattenTokens(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")
  return `${selector} {\n${vars}\n}`
}

/**
 * The full tokens.css text: `:root` carries the default theme, each other
 * theme gets a `:root[data-theme="<name>"]` override block (the default gets
 * one too, so an explicit pick is always honoured). Theme switching is purely
 * client-side: set `data-theme` on <html>.
 */
export const renderTokensCss = (): string => {
  const def = webThemes.find((t) => t.name === DEFAULT_THEME_NAME) ?? webThemes[0]
  if (def === undefined) return ""
  const blocks = [block(":root", def.tokens)]
  for (const theme of webThemes) blocks.push(block(`:root[data-theme="${theme.name}"]`, theme.tokens))
  return `${blocks.join("\n\n")}\n`
}
