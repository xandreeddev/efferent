import type { JSX } from "solid-js"
import { paneBorder, type PaneKind } from "../../state/theme.js"

/**
 * A bordered, focus-accented pane box — the shared shell for the conversation,
 * side, and input panes. The border + title brighten to the pane's accent when
 * focused (dim otherwise, via {@link paneBorder}); the title is padded with
 * spaces to match the old hand-rolled chrome. `grow` makes the pane flex to fill
 * the row (the conversation pane); `width` pins a fixed/percent column (the side
 * pane). Layout is column by default with `minHeight={0}` so inner scrollboxes
 * can shrink.
 */
export const Pane = (props: {
  kind: PaneKind
  focused: boolean
  title: string
  grow?: boolean
  width?: number | `${number}%`
  children: JSX.Element
}) => (
  <box
    border
    title={` ${props.title} `}
    borderColor={paneBorder(props.kind, props.focused)}
    flexGrow={props.grow ? 1 : 0}
    flexShrink={props.grow ? 1 : 0}
    minHeight={0}
    flexDirection="column"
    width={props.width ?? "auto"}
  >
    {props.children}
  </box>
)
