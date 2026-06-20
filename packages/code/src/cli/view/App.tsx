import { Show } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
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
import { SettingsView } from "./overlays/SettingsView.js"
import { Shortcuts } from "./overlays/Shortcuts.js"
import { Login } from "./overlays/Login.js"
import { ApprovalView } from "./overlays/ApprovalView.js"
import { Onboarding } from "./overlays/OnboardingView.js"
import type { TuiContext } from "../state/store.js"

/**
 * Root of the Solid/OpenTUI TUI (agy direction). One **borderless message
 * region** fills the space under the header: it shows the conversation, or — when
 * a contextual panel is focused (`:activity`/`:context`/`:tree`/`:sessions`, or
 * `v`) — that panel in its place. Below it the agy bottom chrome: the pending
 * queue, the input fence, the `:` / `/` contextual menus, and the two-zone status
 * bar. No bordered panes, no sidebar, no floating modals.
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

  // The shortcuts reference card (~30 rows) hands the whole message region over
  // to itself; the short `:` command palette is not an overlay. Otherwise the
  // region shows the conversation, or the contextual panel when it's focused.
  const hidePanes = () => store.overlay().kind === "shortcuts"
  const showConv = () => !hidePanes() && store.focus() !== "side"
  const showSide = () => !hidePanes() && store.focus() === "side"

  // Onboarding is a full-screen takeover (agy-style): while it's open we render
  // ONLY it — no panes/chrome behind it. That lets the onboarding be genuinely
  // transparent (it shows the terminal background, like the rest of the app)
  // with zero risk of the live rail bleeding through.
  const onboarding = () => store.overlay().kind === "onboarding"

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={!onboarding()} fallback={<Onboarding ctx={props.ctx} />}>
        <Header ctx={props.ctx} />
        {/* The single borderless message region: the conversation, or the
            contextual panel (activity/context/agents/sessions) in its place. */}
        <box flexDirection="column" flexGrow={1} minHeight={0}>
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
        {/* Every contextual surface renders INLINE here (borderless, agy-style),
            never as a floating modal — pickers, settings, shortcuts, the login
            flow, and the bash-approval sheet. Only one is ever active at a time
            (the single `overlay` signal), and each Shows on its own kind. */}
        <SelectMenu ctx={props.ctx} />
        <ResumeBrowser ctx={props.ctx} />
        <SettingsView ctx={props.ctx} />
        <Shortcuts ctx={props.ctx} />
        <Login ctx={props.ctx} />
        <ApprovalView ctx={props.ctx} />
        <SearchStatus ctx={props.ctx} />
        <StatusBar ctx={props.ctx} />
      </Show>
    </box>
  )
}
