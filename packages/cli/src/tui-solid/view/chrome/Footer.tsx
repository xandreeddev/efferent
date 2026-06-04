import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/** Dim footer below the status bar (logs path + key hints). Fixed height. */
export const Footer = (props: { ctx: TuiContext }) => (
  <text fg={theme.dim} flexShrink={0}>
    {props.ctx.store.footer()}
  </text>
)
