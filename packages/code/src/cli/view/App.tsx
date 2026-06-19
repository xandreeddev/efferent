import { Show } from "solid-js"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { dispatch } from "../keys/dispatch.js"
import { pasteIntoOverlay } from "../keys/overlay.js"
import { Header } from "./chrome/Header.js"
import { Conversation } from "./panes/Conversation.js"
import { Side } from "./panes/side/Side.js"
import { InputBox } from "./panes/Input.js"
import { QueuedMessages } from "./panes/QueuedMessages.js"
import { SlashPalette } from "./chrome/SlashPalette.js"
import { SelectMenu } from "./chrome/SelectMenu.js"
import { ResumeBrowser } from "./chrome/ResumeBrowser.js"
import { SearchStatus } from "./chrome/SearchStatus.js"
import { StatusBar } from "./chrome/StatusBar.js"
import { Overlay } from "./overlays/Overlay.js"
import { SettingsView } from "./overlays/SettingsView.js"
import { Shortcuts } from "./overlays/Shortcuts.js"
import type { TuiContext } from "../state/store.js"

/**
 * Root of the Solid/OpenTUI TUI. Middle region: two bordered boxes
 * (conversation + activity) with a 1-col gap; below them the keybind box,
 * input, status bar, footer — the same stack as the old `FrameRenderer`. Zoom
 * maximizes the focused read-only pane; the side pane hides on narrow terminals.
 */
export const App = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  useKeyboard((key) => dispatch(props.ctx, key))
  // Bracketed paste arrives as one `paste` event, not keypresses. The native
  // composer <textarea> handles its own paste; route a paste into the open
  // overlay's text field (API key, connection string, …) so it isn't dropped,
  // and preventDefault so the hidden textarea doesn't also swallow it.
  usePaste((event: { bytes?: Uint8Array | string; preventDefault?: () => void }) => {
    const raw = event.bytes
    const decoded = typeof raw === "string" ? raw : raw ? new TextDecoder().decode(raw) : ""
    // These overlays are all single-line fields (keys, URLs, paths), so strip
    // any line breaks a copy picked up rather than inserting stray whitespace.
    const text = decoded.replace(/[\r\n]+/g, "")
    if (text.length > 0 && pasteIntoOverlay(props.ctx, text)) event.preventDefault?.()
  })
  const dims = useTerminalDimensions()
  // Below ~110 cols the side pane is too narrow to read (every row clips) yet
  // still eats 40% of the width — hide it and give the conversation the full
  // pane. It stays reachable: focusing it (w / ^l / :tree / :context) zooms it.
  const wide = () => dims().width >= 110

  // Inline menus render in the bottom chrome below the fence; the panes above
  // shrink to fit. Short menus (pickers, the settings table) leave the bordered
  // panes plenty of room, so they stay. The **shortcuts reference card** is ~30
  // rows, though — it would squeeze the bordered panes below their borders and
  // corrupt the frame — so for that one surface we hand the whole pane area over
  // to it (panes hidden). The short `:` command palette is not an overlay.
  const hidePanes = () => store.overlay().kind === "shortcuts"

  const showConv = () => !hidePanes() && ((wide() && !store.zoomed()) || store.focus() !== "side")
  const showSide = () => !hidePanes() && ((wide() && !store.zoomed()) || store.focus() === "side")

  // Onboarding is a full-screen takeover (agy-style): while it's open we render
  // ONLY it — no panes/chrome behind it. That lets the onboarding be genuinely
  // transparent (it shows the terminal background, like the rest of the app)
  // with zero risk of the live rail bleeding through.
  const onboarding = () => store.overlay().kind === "onboarding"

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={!onboarding()} fallback={<Overlay ctx={props.ctx} />}>
        <Header ctx={props.ctx} />
        <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
          <Show when={showConv()}>
            <Conversation ctx={props.ctx} />
          </Show>
          <Show when={showSide()}>
            <Side ctx={props.ctx} />
          </Show>
        </box>
        {/* agy bottom chrome: the pending queue sits above the input fence; the
            `:` command menu + `/` search drop BELOW it (contextual menus), and
            the two-zone status bar anchors the very bottom. Keybind discovery
            moved to the `?` shortcuts overlay (no persistent footer box). */}
        <QueuedMessages ctx={props.ctx} />
        <InputBox ctx={props.ctx} />
        <SlashPalette ctx={props.ctx} />
        {/* Pickers / settings / shortcuts render INLINE here (borderless,
            agy-style), not as floating modals — the `Overlay` host below skips
            these kinds. Only one is ever active at a time. */}
        <SelectMenu ctx={props.ctx} />
        <ResumeBrowser ctx={props.ctx} />
        <SettingsView ctx={props.ctx} />
        <Shortcuts ctx={props.ctx} />
        <SearchStatus ctx={props.ctx} />
        <StatusBar ctx={props.ctx} />
        {/* Modal layer — absolutely positioned, floats over everything above. */}
        <Overlay ctx={props.ctx} />
      </Show>
    </box>
  )
}
