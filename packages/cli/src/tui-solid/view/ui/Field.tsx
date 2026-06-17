import { Match, Show, Switch } from "solid-js"
import type { FieldState } from "../../presentation/field.js"
import { fieldDisplay } from "../../presentation/field.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor } from "./atoms.js"

const LABEL_W = 16
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

/**
 * The generic key-value control — one component for every value kind:
 *  - **boolean** → `◉ on` / `○ off`
 *  - **select**  → the current option (cycle with ←/→)
 *  - **text / number** → the value, with the block cursor when focused
 *
 * Domain-free: it paints a {@link FieldState} (the pure model) via tokens only.
 * A settings table, a login field, any editor is a column of these — the design
 * system owns the control, the app owns the list.
 */
export const Field = (props: { state: FieldState; focused?: boolean; labelWidth?: number }) => {
  const v = () => props.state.value
  const boolOn = () => v().kind === "boolean" && (v() as { value: boolean }).value
  return (
    <box flexDirection="row">
      <text fg={props.focused ? tokens.accent.input : tokens.text.muted} flexShrink={0}>
        {pad(props.state.label, props.labelWidth ?? LABEL_W)}
      </text>
      <Switch>
        <Match when={v().kind === "boolean"}>
          <text fg={boolOn() ? tokens.state.ok : tokens.text.dim} wrapMode="none">
            {`${boolOn() ? glyph.select.on : glyph.select.off} ${fieldDisplay(props.state)}`}
          </text>
        </Match>
        <Match when={v().kind === "select"}>
          <text fg={tokens.text.default} wrapMode="none">{fieldDisplay(props.state)}</text>
          <text fg={tokens.text.dim} wrapMode="none">{"  ←/→"}</text>
        </Match>
        <Match when={v().kind === "text" || v().kind === "number"}>
          <text fg={tokens.text.default} wrapMode="none">{fieldDisplay(props.state)}</text>
          <Show when={props.focused}>
            <Cursor />
          </Show>
        </Match>
      </Switch>
    </box>
  )
}
