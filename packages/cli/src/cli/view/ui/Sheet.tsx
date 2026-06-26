import { Show, type JSX } from "solid-js"
import { tokens } from "../../state/theme.js"

/** Default contextual-sheet width (cols). Inner rules span {@link SHEET_RULE}. */
export const SHEET_WIDTH = 72
/** Rule width inside a default sheet (width − a little breathing room). */
export const SHEET_RULE = SHEET_WIDTH - 4

/**
 * A **borderless contextual sheet** (agy direction): an optional title line in
 * the overlay accent over a body, width-bounded so forms stay readable. Rendered
 * INLINE in the bottom chrome — no border, no surface, no floating box — so the
 * conversation stays visible above and the sheet rises from the command line like
 * every other agy menu. Replaces the old bordered `Modal`. Used by the login
 * flow's select/prompt steps and the bash-approval sheet; onboarding reuses the
 * width constants for its full-screen body.
 */
export const Sheet = (props: { title?: string; width?: number; children: JSX.Element }) => (
  <box flexDirection="column" flexShrink={0} width={props.width ?? SHEET_WIDTH}>
    <Show when={props.title !== undefined}>
      <text fg={tokens.accent.side} wrapMode="none">
        {props.title}
      </text>
      <box height={1} />
    </Show>
    {props.children}
  </box>
)
