import { Show } from "solid-js"
import type { Overlay as OverlayState } from "../../state/store.js"
import type { TuiContext } from "../../state/store.js"
import { ApprovalView } from "./ApprovalView.js"
import { SelectList } from "./SelectList.js"
import { Login } from "./Login.js"
import { SettingsView } from "./SettingsView.js"
import { OnboardingView } from "./OnboardingView.js"

/**
 * The modal overlay host: an absolutely-positioned, full-screen layer (high
 * zIndex) that floats the active overlay centered over the panes. One
 * discriminated `overlay` signal drives which overlay shows; while open it owns
 * all input (`keys/overlay.ts` routes keys here first). `none` renders nothing,
 * so there is zero cost when no modal is up.
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
        justifyContent="center"
        alignItems="center"
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
        <Show when={o().kind === "onboarding"}>
          <OnboardingView
            state={(o() as Extract<OverlayState, { kind: "onboarding" }>).state}
            note={props.ctx.store.note()}
          />
        </Show>
      </box>
    </Show>
  )
}
