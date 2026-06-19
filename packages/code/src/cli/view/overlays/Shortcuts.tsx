import { Show } from "solid-js"
import { shortcutsTable } from "../../presentation/shortcuts.js"
import { tokens } from "../../state/theme.js"
import { KeyHints } from "../ui/index.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The `?` shortcuts reference — a **borderless inline** card in the bottom chrome
 * (agy `/help` is inline, not a modal). The whole keymap renders as ONE multi-line
 * `<text>` (Yoga-safe: sibling `<text>` in a flex row interleaves glyphs at narrow
 * widths) under a title, with an indented `KeyHints` footer. The floating `Overlay`
 * host skips `shortcuts`; keys come from `keys/overlay.ts`.
 */
export const Shortcuts = (props: { ctx: TuiContext }) => (
  <Show when={props.ctx.store.overlay().kind === "shortcuts"}>
    <box flexDirection="column" flexShrink={0}>
      <text fg={tokens.text.default} wrapMode="none">Keyboard shortcuts</text>
      <box height={1} />
      <text fg={tokens.text.muted} wrapMode="none">
        {shortcutsTable()}
      </text>
      <box height={1} />
      <box paddingLeft={2}>
        <KeyHints hints={[{ key: "esc", label: "Close" }]} />
      </box>
    </box>
  </Show>
)
