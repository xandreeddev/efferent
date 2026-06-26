import type { JSX } from "solid-js"

/**
 * The main-region container — a **borderless** column box (agy direction: no
 * pane boxes, no chrome). It only owns flex behaviour: `grow` flexes it to fill
 * the region (the conversation / an open contextual panel); `width` pins a
 * fixed/percent column when needed. `minHeight={0}` lets an inner scrollbox
 * shrink. Identity (which session, which view) is shown by the header and by a
 * view's own ruled section head — not by a border or a titled box.
 */
export const Pane = (props: {
  grow?: boolean
  width?: number | `${number}%`
  children: JSX.Element
}) => (
  <box
    flexGrow={props.grow ? 1 : 0}
    flexShrink={props.grow ? 1 : 0}
    minHeight={0}
    flexDirection="column"
    width={props.width ?? "auto"}
  >
    {props.children}
  </box>
)
