import { Show, type JSX } from "solid-js"
import { paneBorder, type PaneKind } from "../../state/theme.js"

/**
 * A **borderless** pane — the shared shell for the conversation, side, and input
 * regions (no box frame; agy-style). Focus is shown by a one-line **header**
 * (the title) tinted to the pane's accent when focused, dim otherwise (via
 * {@link paneBorder}, which now reads as "pane accent"). A pane that owns its own
 * header chrome (the side pane's tab row, the input's rule) passes an empty
 * `title` to skip the header line. `grow` flexes the pane to fill the row (the
 * conversation); `width` pins a fixed/percent column (the side pane).
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
    flexGrow={props.grow ? 1 : 0}
    flexShrink={props.grow ? 1 : 0}
    minHeight={0}
    flexDirection="column"
    width={props.width ?? "auto"}
  >
    <Show when={props.title.length > 0}>
      <text fg={paneBorder(props.kind, props.focused)} flexShrink={0} wrapMode="none">
        {props.title}
      </text>
    </Show>
    {props.children}
  </box>
)
