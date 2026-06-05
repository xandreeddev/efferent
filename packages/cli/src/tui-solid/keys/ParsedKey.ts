/**
 * Structural shape of an OpenTUI key event (`@opentui/core` `lib/KeyHandler`'s
 * `ParsedKey`) — the fields our dispatcher reads. Typed structurally so the root
 * `useKeyboard` callback is accepted without coupling to OpenTUI's exact export
 * name, and so key-routing logic is unit-testable with plain objects.
 *
 * Naming follows the parser: a lowercase letter is its own `name` with
 * `shift:false`; an uppercase letter has the lowercased `name` + `shift:true`;
 * `space`/`return`/`tab`/`escape`/`up`/`down`/`left`/`right` are spelled out.
 */
export interface Key {
  readonly name: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly option: boolean
  /**
   * Suppress the default action of the **focused renderable** (the input
   * `<textarea>`) for this key. OpenTUI's key handler fires global listeners
   * (our `dispatch`) *before* the focused renderable and skips the renderable if
   * the event was `preventDefault()`-ed — so calling this lets `dispatch` claim a
   * key (Enter to run a command, Tab to complete, ↑ to recall history) without
   * the textarea also inserting a newline / moving the cursor. Optional because
   * unit tests pass plain `Key` objects with no event behind them.
   */
  readonly preventDefault?: () => void
}
