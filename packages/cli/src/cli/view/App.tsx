import { Show } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { dispatch } from "../keys/dispatch.js"
import { pasteIntoOverlay } from "../keys/overlay.js"
import { focusAccent, glyph, tokens } from "../state/theme.js"
import { Header } from "./chrome/Header.js"
import { RunningLoader } from "./chrome/RunningLoader.js"
import { DecisionsBar } from "./chrome/DecisionsBar.js"
import { Conversation } from "./panes/Conversation.js"
import { AgentPane } from "./panes/AgentPane.js"
import { FleetTree } from "./panes/FleetTree.js"
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
 * Root of the Solid/OpenTUI TUI — **chat-first**. The message region is a fixed
 * two-pane split: the **chat** on the LEFT (the assistant's conversation rail,
 * or — when you jump into an agent from the tree — that agent's live session via
 * `AgentPane`) and the always-visible **fleet tree** on the RIGHT (the
 * workspace's sessions and their sub-agent subtrees with status glyphs). A
 * breadcrumb above the chat says where it points (`assistant` or `assistant ▸
 * <agent folder>`). Exactly three focus targets — input / chat / tree — cycled
 * with `Tab` (Ctrl-h/j/k/l + Ctrl-arrows alias); the focused pane's title/edge
 * brightens to its accent and the others dim. Below the region the bottom
 * chrome: the pending queue, the input fence, the `:`/`/` contextual menus, and
 * the two-zone status bar. No floating modals.
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
  // to itself. Otherwise the chat (left) + the fleet tree (right) are always
  // both shown — the fleet tree replaces the old four cycled side views.
  const hidePanes = () => store.overlay().kind === "shortcuts"
  // The LEFT pane: the assistant's conversation, or — when you've jumped into an
  // agent from the tree — that agent's live session.
  const leftIsAgent = () => store.nodePreview() !== undefined
  // Breadcrumb: where the chat currently points. `agent: <folder>` → `<folder>`.
  const crumb = () => {
    const p = store.nodePreview()
    return p === undefined ? "assistant" : `assistant ${glyph.crumb} ${p.title.replace(/^agent: /, "")}`
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
        {/* The chat-first split: the chat (assistant OR a jumped-into agent) on
            the left, the always-visible fleet tree on the right — 50/50 via
            flexBasis:0 + equal grow, a thin divider tinted to the focused side's
            accent. The shortcuts card takes over the whole region when open. */}
        <Show when={!hidePanes()}>
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            <box flexGrow={3} flexBasis={0} minWidth={0} flexDirection="column">
              {/* Breadcrumb: the chat's accent when chat-focused, dim otherwise. */}
              <box flexDirection="row" flexShrink={0}>
                <text
                  fg={store.focus() === "chat" ? focusAccent("chat") : tokens.text.dim}
                  wrapMode="none"
                >
                  {crumb()}
                </text>
              </box>
              <Show when={leftIsAgent()} fallback={<Conversation ctx={props.ctx} />}>
                <AgentPane ctx={props.ctx} />
              </Show>
            </box>
            <box
              width={1}
              flexShrink={0}
              backgroundColor={
                store.focus() === "tree"
                  ? focusAccent("tree")
                  : store.focus() === "chat"
                    ? focusAccent("chat")
                    : tokens.text.dim
              }
            />
            <box flexGrow={2} flexBasis={0} minWidth={0} flexDirection="column" paddingLeft={1}>
              <FleetTree ctx={props.ctx} />
            </box>
          </box>
        </Show>
        {/* agy bottom chrome, top→bottom: the **running loader** (a spinner line
            while a turn is in flight) sits directly above the input, then the
            **pending queue** (`▸` messages typed mid-turn), then the **decisions
            roster** (`⚠ N decisions need you` from `needs_human` events), then the
            input fence; the `:` command menu + `/` search drop BELOW it
            (contextual menus), and the two-zone status bar anchors the very
            bottom. Keybind discovery moved to the `?` shortcuts overlay (no
            persistent footer box). */}
        <RunningLoader ctx={props.ctx} />
        <QueuedMessages ctx={props.ctx} />
        {/* The passive "decisions need you" roster — `needs_human` events,
            especially PARKED (headless) denials a human only sees on attach.
            The interactive ASK still uses the inline approval sheet below. */}
        <DecisionsBar ctx={props.ctx} />
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
