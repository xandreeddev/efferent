import type { ScrollbackBlock } from "./conversation.js"
import { glyph } from "./theme/index.js"

/**
 * A read-only snapshot of one agent-context node's session, **overlaid** on the
 * conversation pane (the live `blocks` keep receiving event-pump writes
 * underneath — closing simply drops the overlay, so a running turn can never
 * clobber the preview and restore is free). Opened from the `:tree` view.
 */
export interface NodePreview {
  readonly nodeId: string
  /** Pane title while previewing: `agent: <folder>`. */
  readonly title: string
  readonly blocks: ReadonlyArray<ScrollbackBlock>
  /**
   * The live conversation's fold set, parked here while the preview owns the
   * shared `collapsed` signal; restored verbatim on close.
   */
  readonly savedCollapsed: ReadonlySet<string>
}

/**
 * Mark the seed/run boundary in a node's replayed blocks: an info rule before
 * the spawn-time context and another where the run's own messages begin (the
 * first block whose `msgIndex` reaches `seedMessageCount` — splitting by block,
 * not message, keeps cross-boundary tool-call/result patches intact). Rows
 * persisted before the count existed pass through untouched; a node whose run
 * hasn't produced anything yet gets only the seed header.
 */
export const withSeedMarkers = (
  blocks: ReadonlyArray<ScrollbackBlock>,
  seedKind: string,
  seedMessageCount: number | undefined,
): ReadonlyArray<ScrollbackBlock> => {
  if (seedMessageCount === undefined) return blocks
  const rule = glyph.seedRule
  const n = seedMessageCount
  const header: ScrollbackBlock = {
    kind: "info",
    text: `${rule} seed: ${seedKind} · ${n} message${n === 1 ? "" : "s"} loaded at spawn ${rule}`,
  }
  const boundary = blocks.findIndex(
    (b) => "msgIndex" in b && b.msgIndex !== undefined && b.msgIndex >= n,
  )
  if (boundary < 0) return [header, ...blocks]
  return [
    header,
    ...blocks.slice(0, boundary),
    { kind: "info", text: `${rule} run starts ${rule}` },
    ...blocks.slice(boundary),
  ]
}
