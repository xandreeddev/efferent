import { Show } from "solid-js"
import type { Overlay as OverlayState } from "../../state/store.js"
import type { TuiContext } from "../../state/store.js"
import { ApprovalView } from "./ApprovalView.js"
import { Login } from "./Login.js"
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
  // The agy contextual menus — `select` pickers, `settings`, and the `shortcuts`
  // card — render INLINE in the bottom chrome (their own components), so this
  // floating host never draws them. What's left is the genuinely modal stuff:
  // the `login` flow, the bash `approval` prompt (both anchored low, rising from
  // the command line), and `onboarding` (a full-screen first-run takeover — its
  // own absolute box, so the anchor wouldn't affect it anyway).
  const inline = (k: OverlayState["kind"]) =>
    k === "select" || k === "settings" || k === "shortcuts" || k === "resume"
  const hosted = () => o().kind !== "none" && !inline(o().kind)
  const bottom = () => o().kind !== "onboarding"

  return (
    <Show when={hosted()}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={100}
        justifyContent={bottom() ? "flex-end" : "center"}
        alignItems="center"
        paddingBottom={bottom() ? 1 : 0}
      >
        <Show when={o().kind === "login"}>
          <Login flow={(o() as Extract<OverlayState, { kind: "login" }>).flow} />
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
