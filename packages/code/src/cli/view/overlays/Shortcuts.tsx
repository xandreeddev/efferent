import { shortcutsTable } from "../../presentation/shortcuts.js"
import { tokens } from "../../state/theme.js"
import { KeyHints, Modal } from "../ui/index.js"

/**
 * The `?` shortcuts overlay — agy's keybind reference, replacing the old
 * persistent keybind box. The whole keymap renders as ONE multi-line `<text>`
 * (the Yoga-safe pattern: sibling `<text>` in a flex row interleaves glyphs at
 * narrow widths — see the agy-redesign notes), with a `KeyHints` footer.
 */
export const Shortcuts = () => (
  <Modal title="Keyboard shortcuts" width={64}>
    <text fg={tokens.text.muted} wrapMode="none">
      {shortcutsTable()}
    </text>
    <box height={1} />
    <KeyHints hints={[{ key: "esc", label: "close" }]} />
  </Modal>
)
