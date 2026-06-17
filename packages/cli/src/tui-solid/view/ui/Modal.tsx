import { Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { tokens } from "../../state/theme.js"

/** Default panel width (cols). Inner rules span {@link MODAL_RULE}. */
export const MODAL_WIDTH = 72
/** Rule width inside a default panel: width − paddingX(2). */
export const MODAL_RULE = MODAL_WIDTH - 2

/**
 * The shared menu panel — a **borderless**, left-aligned, opaque inline block
 * (agy-style), floated top-left over the conversation column by
 * `overlays/Overlay.tsx`. No box frame; the `title` renders as a plain heading
 * line (left-aligned), then a blank line, then the caller's body (filter line,
 * rows, footer). Owns the overlay surface (`overlay.bg`) + horizontal padding so
 * the menus can't drift. Pass an empty `title` to skip the heading.
 */
export const Modal = (props: { title: string; width?: number; children: JSX.Element }) => {
  const dims = useTerminalDimensions()
  return (
    <box
      flexDirection="column"
      backgroundColor={tokens.overlay.bg}
      width={props.width ?? MODAL_WIDTH}
      // Never taller than the screen leaves room for: an overflowing panel would
      // push its own footer off-screen — exactly the row a stuck user needs.
      maxHeight={Math.max(6, dims().height - 4)}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={props.title.length > 0}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={tokens.text.heading} wrapMode="none">{props.title}</text>
          <text> </text>
        </box>
      </Show>
      {props.children}
    </box>
  )
}
