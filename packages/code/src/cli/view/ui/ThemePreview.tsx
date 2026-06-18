import { For } from "solid-js"
import { glyph, tokens } from "../../state/theme.js"

/**
 * A bordered sample panel that exercises every visible semantic token role, so a
 * theme can be *seen* before it's committed. It paints with the reactive `tokens`
 * proxy (`state/theme.js`) and nothing else — so when the theme step live-swaps
 * the active theme on each highlight move (`keys/overlay.ts`), this panel
 * recolours along with the rest of the UI for free. Every row is a SINGLE
 * single-colour `<text>` (no sibling `<text>` in a flex row — that corrupts under
 * OpenTUI/Yoga), and every glyph comes from `glyph` (no literals in views).
 *
 * Mirrors agy's onboarding theme preview: a tiny conversation showing a prompt,
 * a diff, a thought block, tool/task/done/error/warning lines, a link, an accent,
 * and a dim line — one row per token role.
 */
export const ThemePreview = (props: { width?: number }) => {
  // role → (glyph, text, colour). One entry per visible token; blanks are spacers.
  const rows = () => [
    { fg: tokens.accent.conversation, text: `${glyph.msg.user} you: add a greeting function` },
    { fg: tokens.text.dim, text: "" }, // spacer (renders as a blank box)
    { fg: tokens.text.default, text: "Here's the change:" },
    { fg: tokens.state.error, text: `${glyph.diff.remove} func main() {` },
    { fg: tokens.state.ok, text: `${glyph.diff.add} func greet(name string) {` },
    { fg: tokens.text.dim, text: "" }, // spacer (renders as a blank box)
    { fg: tokens.text.muted, text: `${glyph.fold.open} thought process` },
    { fg: tokens.state.running, text: `${glyph.msg.tool} tool: write_file main.go` },
    { fg: tokens.marker.select, text: `${glyph.select.on} task: implementing greeting` },
    { fg: tokens.state.ok, text: `${glyph.ok} done` },
    { fg: tokens.state.error, text: `${glyph.error} error: compilation failed` },
    { fg: tokens.state.running, text: `${glyph.warn} warning: deprecation` },
    { fg: tokens.syntax.link, text: `${glyph.arrow} link: file:///main.go` },
    { fg: tokens.accent.conversation, text: `${glyph.star} accent: highlighted text` },
    { fg: tokens.text.dim, text: `${glyph.bullet} dim: press enter to continue` },
  ]

  return (
    <box
      border
      title=" preview "
      borderColor={tokens.overlay.border}
      backgroundColor={tokens.bgNone}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      width={props.width ?? "auto"}
    >
      <For each={rows()}>
        {(r) =>
          r.text.length === 0 ? (
            <box height={1} />
          ) : (
            <text fg={r.fg} wrapMode="none">
              {r.text}
            </text>
          )
        }
      </For>
    </box>
  )
}
