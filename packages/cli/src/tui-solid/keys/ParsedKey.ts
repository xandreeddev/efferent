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
}
