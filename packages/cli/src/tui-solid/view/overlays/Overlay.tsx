import { Show } from "solid-js"
import type { Overlay as OverlayState } from "../../state/store.js"
import type { TuiContext } from "../../state/store.js"
import { ApprovalView } from "./ApprovalView.js"
import { SelectList } from "./SelectList.js"
import { HelpView } from "./HelpView.js"
import { Login } from "./Login.js"
import { PromptBox } from "./PromptBox.js"
import { SettingsView } from "./SettingsView.js"

/**
 * The overlay host: an absolutely-positioned, full-screen layer (high zIndex)
 * that floats the active menu **top-left** (agy-style — a borderless inline
 * panel over the conversation column, not a centered box; its opaque bg covers
 * the rail, the sidebar stays visible). One discriminated `overlay` signal
 * drives which menu shows; while open it owns all input (`keys/overlay.ts`
 * routes keys here first). `none` renders nothing, so there is zero cost idle.
 */
export const Overlay = (props: { ctx: TuiContext }) => {
  const o = (): OverlayState => props.ctx.store.overlay()

  return (
    <Show when={o().kind !== "none"}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={100}
        justifyContent="flex-start"
        alignItems="flex-start"
        paddingTop={1}
      >
        <Show when={o().kind === "select"}>
          <SelectList state={(o() as Extract<OverlayState, { kind: "select" }>).sel} />
        </Show>
        <Show when={o().kind === "login"}>
          <Login flow={(o() as Extract<OverlayState, { kind: "login" }>).flow} />
        </Show>
        <Show when={o().kind === "settings"}>
          <SettingsView state={(o() as Extract<OverlayState, { kind: "settings" }>).state} />
        </Show>
        <Show when={o().kind === "approval"}>
          <ApprovalView state={(o() as Extract<OverlayState, { kind: "approval" }>).state} />
        </Show>
        <Show when={o().kind === "help"}>
          <HelpView state={(o() as Extract<OverlayState, { kind: "help" }>).state} />
        </Show>
        <Show when={o().kind === "prompt"}>
          {(() => {
            // `p` must be an accessor (not a captured value): the Show keeps the
            // child mounted while the prompt is open, so static props would
            // freeze at the seed and not reflect typed characters. Reading
            // `o()` inside each prop getter keeps the box reactive.
            const p = () => (o() as Extract<OverlayState, { kind: "prompt" }>).state
            return <PromptBox title={p().title} prompt={p().prompt} value={p().value} mask={p().mask} />
          })()}
        </Show>
      </box>
    </Show>
  )
}
