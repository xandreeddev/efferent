/**
 * A fixed sample "conversation" used to preview a theme's palette in the
 * `:theme` picker — the user sees prose, a diff, a tool pill, a link, and the
 * warning/error accents rendered in the *highlighted* theme before Enter commits
 * it (matches the Antigravity CLI's theme-preview pane).
 *
 * Pure data: each line names a semantic **role**; the view
 * (`view/overlays/ThemePreview.tsx`) maps the role to a token colour + leading
 * marker. No colour or glyph-vocabulary literal lives here (the design-system
 * rule — those belong to `presentation/theme/`); the `+`/`-`/`#` are ordinary
 * code punctuation the view prepends.
 */

export type PreviewRole =
  | "user"
  | "assistant"
  | "tool"
  | "diffAdd"
  | "diffDel"
  | "comment"
  | "link"
  | "warning"
  | "error"

export interface PreviewLine {
  readonly role: PreviewRole
  readonly text: string
}

/** The canned sample, in render order. Kept short enough to fit a modal pane. */
export const THEME_PREVIEW: ReadonlyArray<PreviewLine> = [
  { role: "user", text: "add a greeting function" },
  { role: "assistant", text: "Here's the change:" },
  { role: "tool", text: "edit_file(main.go)" },
  { role: "diffDel", text: "func main() {" },
  { role: "diffAdd", text: "func greet(name string) string {" },
  { role: "diffAdd", text: '  return fmt.Sprintf("Hello, %s!", name)' },
  { role: "comment", text: "greets the caller by name" },
  { role: "link", text: "docs/main.go" },
  { role: "warning", text: "warning: deprecation" },
  { role: "error", text: "error: compilation failed" },
]
