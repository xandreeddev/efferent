import { Show } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { dispatch } from "../keys/dispatch.js"
import { pasteIntoOverlay } from "../keys/overlay.js"
import { tokens } from "../state/theme.js"
import { Header } from "./chrome/Header.js"
import { Conversation } from "./panes/Conversation.js"
import { AgentPane } from "./panes/AgentPane.js"
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
 * Root of the Solid/OpenTUI TUI. The message region is a **two-pane split**: the
 * **orchestrator** (the lead conversation) is always the left pane, and when you
 * select a teammate — or open a contextual panel (`:activity`/`:context`/`:tree`/
 * `:sessions`) — it opens as the **right pane**, 50/50, so you watch an agent
 * work without losing the lead. With nothing selected the orchestrator fills the
 * width. Below it the bottom chrome: the pending queue, the input fence, the `:`
 * / `/` contextual menus, and the two-zone status bar. No floating modals.
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
  // to itself. Otherwise the orchestrator (left) is always shown; the right pane
  // opens for a selected agent (a node preview) or a focused contextual panel.
  const hidePanes = () => store.overlay().kind === "shortcuts"
  const rightPane = (): "none" | "agent" | "side" => {
    if (hidePanes()) return "none"
    if (store.nodePreview() !== undefined) return "agent"
    if (store.focus() === "side") return "side"
    return "none"
  }

  // Onboarding is a full-screen takeover (agy-style): while it's open we render
  // ONLY it — no panes/chrome behind it. That lets the onboarding be genuinely
  // transparent (it shows the terminal background, like the rest of the app)
  // with zero risk of the live rail bleeding through.
  const onboarding = () => store.overlay().kind === "onboarding"

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={!onboarding()} fallback={<Onboarding ctx={props.ctx} />}>
        <Header ctx={props.ctx} />
        {/* The two-pane message region: orchestrator left (always, unless the
            shortcuts card takes over), the selected agent or contextual panel
            right — 50/50 via flexBasis:0 + equal grow, a thin divider between. */}
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <Show when={!hidePanes()}>
            <box flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column">
              <Conversation ctx={props.ctx} />
            </box>
          </Show>
          <Show when={rightPane() !== "none"}>
            <box width={1} flexShrink={0} backgroundColor={tokens.text.dim} />
            <box flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column" paddingLeft={1}>
              <Show when={rightPane() === "agent"} fallback={<Side ctx={props.ctx} />}>
                <AgentPane ctx={props.ctx} />
              </Show>
            </box>
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
