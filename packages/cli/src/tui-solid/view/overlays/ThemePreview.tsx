import { For } from "solid-js"
import type { Tokens } from "../../presentation/theme/index.js"
import type { PreviewLine } from "../../presentation/themePreview.js"
import { THEME_PREVIEW } from "../../presentation/themePreview.js"
import { glyph } from "../../state/theme.js"

/** Width (cols) of the preview pane beside the theme list. */
export const THEME_PREVIEW_W = 42

/**
 * Map a preview line's role to a colour from the **passed** token set (the
 * candidate theme — never the reactive `tokens` proxy, which is the *active*
 * theme) plus a leading marker. This is the whole point: paint the sample in the
 * theme being highlighted, so it's visible before it's applied.
 */
const paint = (line: PreviewLine, t: Tokens): { fg: string; text: string } => {
  switch (line.role) {
    case "user":
      return { fg: t.text.user, text: `${glyph.msg.user} ${line.text}` }
    case "assistant":
      return { fg: t.text.assistant, text: line.text }
    case "tool":
      return { fg: t.state.ok, text: `${glyph.railDot} ${line.text}` }
    case "diffAdd":
      return { fg: t.state.ok, text: `+ ${line.text}` }
    case "diffDel":
      return { fg: t.state.error, text: `- ${line.text}` }
    case "comment":
      return { fg: t.syntax.comment, text: `# ${line.text}` }
    case "link":
      return { fg: t.syntax.link, text: line.text }
    case "warning":
      return { fg: t.state.running, text: line.text }
    case "error":
      return { fg: t.state.error, text: line.text }
  }
}

/**
 * The theme-picker preview pane (Feature 1) — renders the fixed sample
 * conversation ({@link THEME_PREVIEW}) in a candidate theme's tokens. Takes the
 * token set as a *value* so it shows the highlighted theme; the pane's own
 * background uses that theme's overlay surface so the contrast reads true.
 */
export const ThemePreview = (props: { tokens: Tokens }) => (
  <box
    flexDirection="column"
    width={THEME_PREVIEW_W}
    backgroundColor={props.tokens.overlay.bg}
    paddingLeft={1}
    paddingRight={1}
  >
    <For each={THEME_PREVIEW}>
      {(line) => {
        const r = () => paint(line, props.tokens)
        return (
          <text fg={r().fg} wrapMode="none">
            {r().text}
          </text>
        )
      }}
    </For>
  </box>
)
