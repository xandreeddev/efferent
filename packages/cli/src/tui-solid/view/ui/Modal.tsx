import type { JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { tokens } from "../../state/theme.js"

/** Default modal width (cols). Inner content rules span {@link MODAL_RULE}. */
export const MODAL_WIDTH = 72
/** Rule width inside a default modal: width − border(2) − paddingX(2). */
export const MODAL_RULE = MODAL_WIDTH - 4

/**
 * The shared modal shell — a centered, bordered, opaque overlay box floated over
 * the panes by `overlays/Overlay.tsx`. Owns the overlay surface (`overlay.bg`),
 * the side-accent border, and the horizontal padding; callers supply the title
 * and body (filter line, rows, footer). Used by the select list, prompt box, and
 * settings overlays so they can't drift.
 */
export const Modal = (props: { title: string; width?: number; children: JSX.Element }) => {
  const dims = useTerminalDimensions()
  return (
    <box
      flexDirection="column"
      border
      title={` ${props.title} `}
      borderColor={tokens.overlay.border}
      backgroundColor={tokens.overlay.bg}
      width={props.width ?? MODAL_WIDTH}
      // Never taller than the screen leaves room for: an overflowing modal
      // paints over the input/status chrome on short terminals with its own
      // key-hint footer pushed off-screen — exactly the row a stuck user needs.
      maxHeight={Math.max(6, dims().height - 4)}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}
