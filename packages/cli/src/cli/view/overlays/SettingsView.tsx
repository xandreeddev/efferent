import { createMemo, For, Show } from "solid-js"
import type { Overlay as OverlayState, TuiContext } from "../../state/store.js"
import type { SettingsState } from "../../presentation/settingsView.js"
import { currentRow } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../state/theme.js"
import { KeyHints } from "../ui/index.js"

const MAX_ROWS = 12
const LABEL_W = 18
const VALUE_MAX = 14

/**
 * The `:settings` table — a **borderless inline** menu in the bottom chrome (agy
 * `/config` is inline, not a modal): a title, the key/value rows (each ONE
 * pre-formatted `<text>` line — sibling `<text>` in a flex row corrupts under
 * Yoga), a per-row hint, and an indented `KeyHints` footer. Reads the active
 * settings overlay from the store (the floating `Overlay` host skips `settings`);
 * keys still come from `keys/overlay.ts` on the same `SettingsState`.
 */
const SettingsBody = (props: { state: SettingsState }) => {
  const s = () => props.state
  const editingIdx = () => (s().editBuffer !== undefined ? s().cursor : -1)
  const focused = () => currentRow(s())
  const n = () => s().rows.length

  const listRows = () => Math.min(MAX_ROWS, Math.max(1, n()))

  const win = createMemo(() => {
    const rows = listRows()
    let start = s().cursor - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, moreAbove: start > 0, moreBelow: start + rows < n() }
  })

  const rows = createMemo(() => {
    const w = win()
    const out: Array<{ text: string; focused: boolean }> = []
    for (let pos = 0; pos < w.rows; pos++) {
      const idx = w.start + pos
      const row = s().rows[idx]!
      const isFocused = idx === s().cursor
      const isEditing = idx === editingIdx()

      let marker = " "
      if (isFocused) marker = glyph.pointer
      else if (pos === 0 && w.moreAbove) marker = glyph.more.above
      else if (pos === w.rows - 1 && w.moreBelow) marker = glyph.more.below

      const label = row.label.padEnd(LABEL_W, " ")

      let value: string
      if (isEditing && s().editBuffer !== undefined) {
        value = s().editBuffer!
      } else {
        value = row.value.length > 0 ? row.value : "default"
        if (value.length > VALUE_MAX) value = `${value.slice(0, VALUE_MAX - 1)}…`
      }

      out.push({ text: `${marker} ${label}${value}`, focused: isFocused })
    }
    return out
  })

  const focusedHint = () => focused()?.hint

  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={tokens.text.default} wrapMode="none">{s().title}</text>
      <box height={1} />
      <box flexDirection="column">
        <For each={rows()}>
          {(r) => (
            <text
              fg={r.focused ? tokens.marker.select : tokens.text.default}
              wrapMode="none"
              {...(r.focused ? { backgroundColor: tokens.cursorLine } : {})}
            >
              {r.text}
            </text>
          )}
        </For>
      </box>
      <Show when={focusedHint() !== undefined}>
        <text fg={tokens.text.dim} wrapMode="word" marginTop={1}>
          {focusedHint()}
        </text>
      </Show>
      <box height={1} />
      <box paddingLeft={2}>
        <Show
          when={s().editBuffer !== undefined}
          fallback={
            <KeyHints
              hints={[
                { key: "↑/↓", label: "Navigate" },
                { key: "↵", label: "toggle / cycle / edit" },
                { key: "esc", label: "Close" },
              ]}
            />
          }
        >
          <KeyHints
            hints={[
              { key: "type", label: "a value" },
              { key: "↵", label: "Save" },
              { key: "esc", label: "Cancel" },
            ]}
          />
        </Show>
      </box>
    </box>
  )
}

/** Inline `:settings` — renders {@link SettingsBody} in the bottom chrome when a
 *  settings overlay is active (keyed `Show` so it never reads `.state` off a
 *  different overlay). */
export const SettingsView = (props: { ctx: TuiContext }) => {
  const state = createMemo((): SettingsState | undefined => {
    const o: OverlayState = props.ctx.store.overlay()
    return o.kind === "settings" ? o.state : undefined
  })
  return (
    <Show when={state()}>
      {(st) => <SettingsBody state={st()} />}
    </Show>
  )
}
