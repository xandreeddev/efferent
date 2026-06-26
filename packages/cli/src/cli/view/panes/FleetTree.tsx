import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"
import { ContextTreeView } from "./side/ContextTree.js"
import { NodeDetail } from "./side/NodeDetail.js"

/**
 * The RIGHT pane of the chat-first layout: the **fleet tree** — every session
 * in the workspace and its persisted sub-agent subtree, with running/idle/ok/
 * error status glyphs (rendered by `ContextTreeView`, the reused `:tree` view).
 * Always visible for the master TUI (it replaces the old four cycled side
 * views). Split into the navigator tree on top (holds the cursor) and a live
 * **detail section** below it following the cursor.
 *
 * The title brightens to the tree accent when the tree pane is focused and dims
 * otherwise, so focus is obvious; the chat pane carries the matching cue on the
 * left. `↵` on a node opens its session into the LEFT chat (`openNodePreview`);
 * `↵` on the active row / Esc returns the chat to the assistant.
 */
export const FleetTree = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const focused = () => store.focus() === "tree"
  // One pane, both bins: the current session's fleet (coordinator → agents →
  // sub-agents), always expanded, live status. No multi-session list, no tabs.
  const subtitle = () => "  · this session's fleet"

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <text fg={focused() ? tokens.accent.side : tokens.text.dim} wrapMode="none">
          {`${focused() ? glyph.pointer : " "} fleet`}
        </text>
        <text fg={tokens.text.dim} wrapMode="none">
          {subtitle()}
        </text>
      </box>
      {/* Tree on top (holds the cursor); the detail mirrors the cursor below,
          capped at half the region so a short detail never costs 50%. */}
      <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
        <ContextTreeView ctx={props.ctx} />
      </box>
      <box flexDirection="column" flexShrink={0} maxHeight="50%" overflow="hidden" marginTop={1}>
        <text fg={tokens.accent.side} flexShrink={0}>
          {`${glyph.seedRule} selected ${glyph.seedRule}`}
        </text>
        <NodeDetail ctx={props.ctx} />
      </box>
    </box>
  )
}
