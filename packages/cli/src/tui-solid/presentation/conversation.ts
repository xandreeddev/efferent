/**
 * Pure conversation structure model for the Solid/OpenTUI TUI.
 *
 * This is the presentation-independent half of the old `tui/scrollback.ts`:
 * it turns a flat, append-only list of `ScrollbackBlock`s into the Neogit-style
 * turn/tool-group tree the conversation rail renders, WITHOUT any ANSI, cursor,
 * search or selection machinery (OpenTUI's `<scrollbox>` + Solid components own
 * those now). The block shape is byte-for-byte the same union the agent event
 * reducer already constructs, so the lifted reducer code feeds it unchanged.
 *
 * Fold identity mirrors `scrollback.ts`'s `flatten()`:
 *   - a TURN (user message + everything until the next user msg / checkpoint)
 *     folds under `turn:<index>` and shows `· N steps` when collapsed,
 *   - a run of ≥2 consecutive tool calls folds under `grp:<firstToolId>` (keyed
 *     on the first member, so a tool streaming into the run keeps it folded),
 *   - single tools / prose / info / error render inline.
 * Indices are stable because the list is append-only and tools update in place
 * by id (never spliced) — the same guarantee the old `blockSeq` WeakMap gave.
 */

export type ToolPillState = "running" | "ok" | "error"

export type ScrollbackBlock =
  | { readonly kind: "user"; readonly text: string; readonly msgIndex?: number }
  | { readonly kind: "assistant"; readonly text: string; readonly msgIndex?: number }
  | { readonly kind: "reasoning"; readonly text: string; readonly msgIndex?: number }
  | {
      readonly kind: "tool"
      readonly id: string
      /** Semantic call label, e.g. `read foo.ts L1-40`. */
      readonly toolName: string
      readonly state: ToolPillState
      /** One-line result summary, e.g. `50 lines`, `+12/-3`, `exit 0`. */
      readonly detail?: string
      /** Unified diff (edit_file/write_file) — rendered colorized below the pill. */
      readonly diff?: string
      /** Full textual output (bash/grep/read) — shown when expanded. */
      readonly output?: string
      readonly msgIndex?: number
    }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "checkpoint"; readonly text: string }

export type ToolBlock = Extract<ScrollbackBlock, { kind: "tool" }>

/** An item inside a turn body (or a loose run outside any turn). */
export type BodyItem =
  | { readonly kind: "block"; readonly id: string; readonly block: ScrollbackBlock }
  | { readonly kind: "toolGroup"; readonly id: string; readonly tools: ReadonlyArray<ToolBlock> }

/** A top-level unit of the conversation rail. */
export type ConversationItem =
  | {
      readonly kind: "turn"
      readonly id: string
      readonly subject: string
      /** Raw block count after the user message — the folded `· N steps`. */
      readonly steps: number
      readonly body: ReadonlyArray<BodyItem>
    }
  | { readonly kind: "loose"; readonly body: ReadonlyArray<BodyItem> }
  | { readonly kind: "checkpoint"; readonly id: string; readonly text: string }

/** Stable id for a block: tools keep their own id, others key on position. */
const idOf = (block: ScrollbackBlock, index: number): string =>
  block.kind === "tool" ? block.id : `b:${index}`

/** A block paired with its absolute index in the source list (for stable ids). */
interface Indexed {
  readonly block: ScrollbackBlock
  readonly index: number
}

/**
 * Group a run of blocks into body items: consecutive tool calls of length ≥2
 * collapse into one `toolGroup` (keyed on the first member's id); everything
 * else — single tools, assistant/reasoning prose, info/error — stays inline.
 */
const buildBody = (run: ReadonlyArray<Indexed>): BodyItem[] => {
  const out: BodyItem[] = []
  let k = 0
  while (k < run.length) {
    const { block, index } = run[k]!
    if (block.kind === "tool") {
      let m = k + 1
      while (m < run.length && run[m]!.block.kind === "tool") m++
      const tools = run.slice(k, m).map((r) => r.block as ToolBlock)
      if (tools.length >= 2) {
        out.push({ kind: "toolGroup", id: `grp:${tools[0]!.id}`, tools })
      } else {
        out.push({ kind: "block", id: block.id, block })
      }
      k = m
      continue
    }
    out.push({ kind: "block", id: idOf(block, index), block })
    k++
  }
  return out
}

/** True for blocks that close a turn / loose run when scanning forward. */
const isBoundary = (block: ScrollbackBlock): boolean =>
  block.kind === "user" || block.kind === "checkpoint"

/**
 * Partition the flat block list into the conversation rail's top-level items:
 * user-led turns, standalone checkpoints, and loose runs (leading content or
 * content emitted right after a fold). Mirrors `scrollback.ts` `flatten()`.
 */
export const buildConversation = (
  blocks: ReadonlyArray<ScrollbackBlock>,
): ConversationItem[] => {
  const items: ConversationItem[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!
    if (block.kind === "user") {
      let j = i + 1
      while (j < blocks.length && !isBoundary(blocks[j]!)) j++
      const body: Indexed[] = []
      for (let k = i + 1; k < j; k++) body.push({ block: blocks[k]!, index: k })
      items.push({
        kind: "turn",
        id: `turn:${i}`,
        subject: block.text,
        steps: body.length,
        body: buildBody(body),
      })
      i = j
    } else if (block.kind === "checkpoint") {
      items.push({ kind: "checkpoint", id: `b:${i}`, text: block.text })
      i++
    } else {
      let j = i
      while (j < blocks.length && !isBoundary(blocks[j]!)) j++
      const run: Indexed[] = []
      for (let k = i; k < j; k++) run.push({ block: blocks[k]!, index: k })
      items.push({ kind: "loose", body: buildBody(run) })
      i = j
    }
  }
  return items
}

/**
 * The DOM/scroll id of a top-level item. Turns and checkpoints carry their own
 * stable id; loose runs (no own id) key on render position, so this MUST be
 * called with the same index the renderer's `<For>` uses, and search matches
 * must resolve their scroll target through this same helper.
 */
export const conversationItemId = (item: ConversationItem, index: number): string =>
  item.kind === "loose" ? `loose:${index}` : item.id

/** All searchable text of a single block (prose, tool label/detail/output). */
const blockText = (block: ScrollbackBlock): string => {
  switch (block.kind) {
    case "tool":
      return [block.toolName, block.detail, block.output].filter(Boolean).join(" ")
    default:
      return block.text
  }
}

/** All searchable text of a top-level item (subject + every body block). */
export const itemText = (item: ConversationItem): string => {
  if (item.kind === "checkpoint") return item.text
  const parts: string[] = item.kind === "turn" ? [item.subject] : []
  const body = item.kind === "turn" || item.kind === "loose" ? item.body : []
  for (const b of body) {
    if (b.kind === "toolGroup") for (const t of b.tools) parts.push(blockText(t))
    else parts.push(blockText(b.block))
  }
  return parts.join(" ")
}

/** Every foldable section id in render order — drives fold-all / unfold-all. */
export const foldableIds = (items: ReadonlyArray<ConversationItem>): string[] => {
  const ids: string[] = []
  for (const item of items) {
    if (item.kind === "turn") {
      ids.push(item.id)
      for (const b of item.body) if (b.kind === "toolGroup") ids.push(b.id)
    } else if (item.kind === "loose") {
      for (const b of item.body) if (b.kind === "toolGroup") ids.push(b.id)
    }
  }
  return ids
}
