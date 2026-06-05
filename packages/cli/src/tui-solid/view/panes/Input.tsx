import type { TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, onMount } from "solid-js"
import { runCommand } from "../../commands/runCommand.js"
import { runSearch } from "../../actions/search.js"
import { pushPrompt } from "../../presentation/promptHistory.js"
import { tokens } from "../../state/theme.js"
import { Pane } from "../ui/index.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Textarea keymap: **Enter inserts a newline, Shift+Enter submits.** Enter→newline
 * and Meta/Alt+Enter→submit are OpenTUI's defaults; we only add Shift+Enter→submit
 * on top (the rest — arrows, word motions, backspace, Ctrl-U/W kills, undo/redo —
 * is inherited unchanged).
 *
 * Shift+Enter needs a terminal that disambiguates it from Enter via the Kitty
 * keyboard protocol (OpenTUI negotiates it by default — kitty / ghostty / foot /
 * wezterm / recent alacritty, or tmux with `extended-keys on`). Where the
 * terminal can't, Shift+Enter is indistinguishable from Enter (so it inserts a
 * newline) — but **Alt+Enter always submits** (the ESC-prefixed default works
 * without the protocol), so there is always a keyboard path to send.
 */
const KEY_BINDINGS = [{ name: "return", shift: true, action: "submit" as const }]

const MAX_ROWS = 8

/**
 * Multi-line OpenTUI `<textarea>` (Enter submits · Ctrl-J newline · paste keeps
 * newlines). Used uncontrolled with a `ref` so submit clears the native buffer
 * without a controlled-value re-render loop; `onContentChange` mirrors the text
 * into the store (the `:` palette + search prefix read it). The box grows with
 * the content up to {@link MAX_ROWS} rows, then the textarea scrolls.
 *
 * Focus is driven imperatively through the ref (`focus()`/`blur()`): the
 * `focused` prop alone does NOT blur the renderable, so a defocused textarea
 * would keep receiving keys — and its submit would fire (sending an empty turn)
 * while a modal overlay or another pane is active. The effect keeps the
 * renderable's focus in lockstep with `focused()`, and submit additionally
 * guards on it so a stray Enter can never submit behind an overlay.
 */
export const InputBox = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const focused = () => store.focus() === "input" && store.overlay().kind === "none"
  // Solid assigns this before any event fires; `!` keeps the prop type clean
  // under exactOptionalPropertyTypes.
  let ref!: TextareaRenderable

  // Imperatively blur/focus so a non-focused textarea stops consuming keys.
  // Initial mount focuses synchronously (so the user can type at once); every
  // LATER transition into focus is DEFERRED a macrotask. The keystroke that
  // closes an overlay flips `focused()` true on the same tick, and a synchronous
  // `ref.focus()` would let that very Enter reach the textarea as a stray
  // newline — deferring keeps it blurred while the closing key is processed, then
  // focuses for the next one. Blur is always synchronous (stop keys immediately).
  let primed = false
  createEffect(() => {
    if (focused()) {
      if (primed) setTimeout(() => focused() && ref.focus(), 0)
      else ref.focus()
    } else {
      ref.blur()
    }
    primed = true
  })

  // Register the input handle so a `/`-in-pane keystroke can seed the buffer
  // (the dispatch flips focus here; the effect above then focuses the ref).
  onMount(() => {
    store.inputControl.current = {
      seed: (text) => {
        ref.setText(text)
        // `setText` resets the cursor to offset 0; move it to the end so a Tab-
        // completed command / recalled message is ready to keep typing or edit.
        ref.cursorOffset = text.length
        store.setInput(text)
      },
    }
  })

  // Grow the box with the content (1..MAX_ROWS visible rows).
  const rows = createMemo(() => {
    const n = store.input().length === 0 ? 1 : store.input().split("\n").length
    return Math.max(1, Math.min(MAX_ROWS, n))
  })

  const submit = (): void => {
    // Only the focused textarea may submit. It can still fire `submit` as an
    // overlay closes on the SAME keystroke (the global handler closes it first,
    // flipping `focused()` true mid-event), so we also never submit an empty
    // buffer — an empty turn is never wanted and is exactly what that race sends.
    if (!focused()) return
    const value = ref.plainText
    const v = value.trim()
    if (v.length === 0) return
    ref.setText("")
    store.setInput("")
    // `:` → ex-style command · `/` → conversation search · else send the message
    // (and remember it for ↑/↓ recall — commands/searches aren't message history).
    if (v.startsWith(":")) runCommand(props.ctx, v)
    else if (v.startsWith("/") && v.length > 1) runSearch(store, v.slice(1))
    else {
      store.setHistory(pushPrompt(store.history(), value))
      props.ctx.submit(value)
    }
  }

  return (
    <Pane kind="input" focused={focused()} title="input">
      <textarea
        ref={ref}
        height={rows()}
        keyBindings={KEY_BINDINGS}
        placeholder="Message…  (Shift-Enter send · Enter newline · Ctrl-C quit)"
        textColor={tokens.text.default}
        wrapMode="word"
        onContentChange={() => {
          // A <textarea> fires a *contentless* content-change (the `"input"`
          // event with `plainText` is single-line-<input> only), so read the
          // buffer off the ref. The zero-arg handler satisfies the prop's
          // (broken) `(event) & (value)` intersection type.
          if (!focused()) return
          const t = ref.plainText
          store.setInput(t)
          // Typing re-filters the palette from the top.
          store.setPaletteIndex(0)
          // If the buffer no longer matches the recalled entry (the user edited
          // it, or typed a fresh draft), stop browsing history so the next ↑
          // starts from the newest again. A recall seeds exactly the shown text,
          // so this won't fire on the recall itself.
          const h = store.history()
          if (h.pos !== null && t !== (h.entries[h.pos] ?? h.draft)) {
            store.setHistory({ ...h, pos: null })
          }
        }}
        onSubmit={submit}
      />
    </Pane>
  )
}
