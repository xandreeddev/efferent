export type ThemeName = "dark" | "light" | "mono"
export const themes = {
  dark: { background: "#101820", surface: "#18242d", text: "#e4ebef", muted: "#97aab6", accent: "#65d6c4", rule: "#32434f", danger: "#ff9a91", warning: "#ecc47b" },
  light: { background: "#f5f4ef", surface: "#e8ece9", text: "#20343c", muted: "#54676e", accent: "#006c63", rule: "#acbcbf", danger: "#a7312a", warning: "#865b00" },
  mono: { background: "#000000", surface: "#000000", text: "#ffffff", muted: "#ffffff", accent: "#ffffff", rule: "#ffffff", danger: "#ffffff", warning: "#ffffff" },
} as const
