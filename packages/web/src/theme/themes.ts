import {
  defaultPalette,
  defaultSurfaces,
  efferentPalette,
  efferentSurfaces,
  tokyoNightPalette,
  tokyoNightSurfaces,
} from "./palette.js"
import { makeWebTokens, type WebTokens } from "./tokens.js"

export interface WebTheme {
  readonly name: string
  readonly tokens: WebTokens
}

/** Registry — same names as the TUI's theme registry. */
export const webThemes: ReadonlyArray<WebTheme> = [
  { name: "efferent", tokens: makeWebTokens(efferentPalette, efferentSurfaces) },
  { name: "one-dark", tokens: makeWebTokens(defaultPalette, defaultSurfaces) },
  { name: "tokyo-night", tokens: makeWebTokens(tokyoNightPalette, tokyoNightSurfaces) },
]

export const DEFAULT_THEME_NAME = "efferent"
