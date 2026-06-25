import { createMemo, For, Show } from "solid-js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"

/**
 * The agent's working plan — the latest ROOT `update_plan` checklist — pinned in
 * the fleet pane so it's **always visible**, not gated on where the tree cursor
 * sits (the old NodeDetail/RootView placement vanished the moment you navigated
 * a node). Both drivers feed `projection().plan` through the same event reducer
 * (`makeEventReducer`), so it renders identically on the in-process and remote
 * paths. Hidden when there is no plan. Capped at 8 rows so a long plan never
 * crowds out the tree below; the pane clips the rest.
 *
 * Glyphs: ✓ done · ● active · ○ pending (the same vocabulary the tree uses).
 */
export const PlanSection = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const plan = createMemo(() => store.projection().plan)
  return (
    <Show when={plan().length > 0}>
      <box flexDirection="column" flexShrink={0} marginBottom={1} overflow="hidden">
        <text fg={tokens.accent.side} flexShrink={0} wrapMode="none">
          {`${glyph.seedRule} plan ${glyph.seedRule}`}
        </text>
        <For each={plan().slice(0, 8)}>
          {(s) => (
            <text
              fg={
                s.status === "active"
                  ? tokens.state.running
                  : s.status === "done"
                    ? tokens.text.dim
                    : tokens.text.muted
              }
              wrapMode="none"
            >
              {`  ${s.status === "done" ? glyph.ok : s.status === "active" ? glyph.railDot : glyph.idleDot} ${s.step}`}
            </text>
          )}
        </For>
        <Show when={plan().length > 8}>
          <text fg={tokens.text.dim} wrapMode="none">{`    … ${plan().length - 8} more`}</text>
        </Show>
      </box>
    </Show>
  )
}
