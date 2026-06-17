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

import type { NavRow } from "./paneNav.js"

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
  | {
      /** One live container for a turn's parallel sub-agent fan-out — a
       *  Claude-style `Running N agents…` block with one row per run,
       *  updated in place by the event pump (never one pill per spawn). */
      readonly kind: "agents"
      readonly id: string
      readonly agents: ReadonlyArray<AgentRunRow>
    }

/** One sub-agent's live row inside an `agents` block. */
export interface AgentRunRow {
  readonly nodeId: string
  readonly name: string
  readonly status: ToolPillState
  readonly toolUses: number
  /** Billed tokens so far (Σ input+output per LLM call in the run). */
  readonly tokens: number
  /** The tool currently executing, for the running row's live sub-line. */
  readonly currentTool?: string
  /** The run's returned summary — what the sub-agent handed back to the
   *  parent. Shown (truncated) on the finished row's sub-line; without it the
   *  rail says only "Done" and the deliverable is invisible. */
  readonly summary?: string
}

/** Truncate a sub-agent summary for its rail row — long briefs would wall the
 *  conversation; the full text lives on the node (`:tree` → ↵). */
export const agentSummaryPreview = (s: string, max = 400): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`

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
      /** First line, truncated — what the FOLDED head shows. */
      readonly subject: string
      /** The user message verbatim — what the EXPANDED head shows. The head
       *  owns the message in both states (never copied into the body), so it
       *  renders exactly once. */
      readonly text: string
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

// (A turn's head shows `text` expanded / `subject` folded — the old scheme of
// copying a big user message into the body so it could fold rendered the
// message TWICE when expanded: truncated subject + full body copy.)

/** First line of a user message, truncated — the turn-header / Activity-run subject. */
export const subjectLine = (text: string): string => {
  const line = (text.split("\n", 1)[0] ?? text).trimEnd()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

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
        subject: subjectLine(block.text),
        text: block.text,
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
    case "agents":
      return block.agents.flatMap((a) => [a.name, a.summary ?? ""]).join(" ")
    default:
      return block.text
  }
}

/** All searchable text of a top-level item (subject + every body block). */
export const itemText = (item: ConversationItem): string => {
  if (item.kind === "checkpoint") return item.text
  const parts: string[] = item.kind === "turn" ? [item.text] : []
  const body = item.kind === "turn" || item.kind === "loose" ? item.body : []
  for (const b of body) {
    if (b.kind === "toolGroup") for (const t of b.tools) parts.push(blockText(t))
    else parts.push(blockText(b.block))
  }
  return parts.join(" ")
}

/**
 * One `/`-search match, at ROW granularity (a turn head, a body item, a
 * checkpoint) — `id` is the rendered box id, so highlight + scroll line up with
 * what's on screen. A hit inside a folded unit carries what must change to make
 * it visible: `turnId` (remove from `collapsed` — a turn folds when its id is a
 * member) and/or `groupId` (ADD to `collapsed` — tool groups have the inverse
 * polarity, membership ⇒ expanded).
 */
export interface SearchHit {
  readonly id: string
  readonly turnId?: string
  readonly groupId?: string
}

/** One segment of a text split by search matches — `match` segments render as
 *  highlighted word chips, the rest as plain text. */
export interface MatchSegment {
  readonly text: string
  readonly match: boolean
}

/**
 * Split `text` on every case-insensitive occurrence of `query` — the model
 * behind the WORD-level search highlight (vim hlsearch: the matched substring
 * itself gets a chip, not just the row). Blank query or no hit → one unmatched
 * segment. Segments always concatenate back to `text` verbatim.
 *
 * Case-folding caveat: positions are found in `text.toLowerCase()`, which is
 * only index-aligned with `text` when lowering doesn't change length (it can:
 * 'İ' lowers to two code units). When either side lowers to a different
 * length, fall back to exact-case matching rather than chip a skewed region.
 */
export const splitByMatch = (text: string, query: string): ReadonlyArray<MatchSegment> => {
  const trimmed = query.trim()
  if (trimmed.length === 0 || text.length === 0) return [{ text, match: false }]
  const lowerText = text.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  const stable = lowerText.length === text.length && lowerQuery.length === trimmed.length
  const hay = stable ? lowerText : text
  const q = stable ? lowerQuery : trimmed
  const out: MatchSegment[] = []
  let i = 0
  while (i < text.length) {
    const at = hay.indexOf(q, i)
    if (at === -1) {
      out.push({ text: text.slice(i), match: false })
      break
    }
    if (at > i) out.push({ text: text.slice(i, at), match: false })
    out.push({ text: text.slice(at, at + q.length), match: true })
    i = at + q.length
  }
  return out
}

/**
 * Find every row matching `query` (case-insensitive substring), in render
 * order. Matches FOLDED content too — that's the point: the hit records how to
 * reveal itself, so jumping to it can auto-expand instead of silently parking
 * on a fold that hides the match.
 */
export const searchConversation = (
  items: ReadonlyArray<ConversationItem>,
  query: string,
): SearchHit[] => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const has = (text: string): boolean => text.toLowerCase().includes(q)
  const hits: SearchHit[] = []
  const bodyHits = (body: ReadonlyArray<BodyItem>, turnId?: string): void => {
    const inTurn = turnId !== undefined ? { turnId } : {}
    for (const b of body) {
      if (b.kind === "toolGroup") {
        // The group is one rendered row; a match in any member (or the summary
        // line itself) hits the group and expands it to show the pills.
        if (has(toolGroupSummary(b.tools)) || b.tools.some((t) => has(blockText(t))))
          hits.push({ id: b.id, ...inTurn, groupId: b.id })
      } else if (has(blockText(b.block))) {
        hits.push({ id: b.id, ...inTurn })
      }
    }
  }
  for (const item of items) {
    if (item.kind === "checkpoint") {
      if (has(item.text)) hits.push({ id: item.id })
    } else if (item.kind === "turn") {
      if (has(item.text)) hits.push({ id: item.id })
      bodyHits(item.body, item.id)
    } else {
      bodyHits(item.body)
    }
  }
  return hits
}

/**
 * Foldable ids split by kind — drives fold-all / unfold-all (`Z`). The two kinds
 * have **opposite defaults**: a turn defaults expanded (its id ∈ `collapsed` ⇒
 * folded), a tool group defaults collapsed to its one-line summary (its id ∈
 * `collapsed` ⇒ expanded). So `Z` can't treat them uniformly — it folds every
 * turn + collapses every group ("compact"), then expands both, by setting the
 * right membership per kind.
 */
export const foldIdsByKind = (
  items: ReadonlyArray<ConversationItem>,
): { readonly turns: ReadonlyArray<string>; readonly groups: ReadonlyArray<string> } => {
  const turns: string[] = []
  const groups: string[] = []
  for (const item of items) {
    if (item.kind === "turn") {
      turns.push(item.id)
      for (const b of item.body) if (b.kind === "toolGroup") groups.push(b.id)
    } else if (item.kind === "loose") {
      for (const b of item.body) if (b.kind === "toolGroup") groups.push(b.id)
    }
  }
  return { turns, groups }
}

/** A tool call's short verb for the group summary: the head of its `ToolName(arg)`
 *  label, lowercased — `Edit(a.ts)` → `edit`, `Bash(npm i)` → `bash`. */
const toolVerb = (label: string): string => {
  const i = label.indexOf("(")
  return (i === -1 ? label : label.slice(0, i)).toLowerCase()
}

/** Aggregate state of a tool group: error if any failed, else running if any is
 *  still in flight, else ok. Drives the collapsed summary's caret colour. */
export const toolGroupState = (tools: ReadonlyArray<ToolBlock>): ToolPillState =>
  tools.some((t) => t.state === "error")
    ? "error"
    : tools.some((t) => t.state === "running")
      ? "running"
      : "ok"

/**
 * Whether a tool group renders expanded: the user opened it (inverse-polarity
 * membership in `collapsed`), or it's STILL RUNNING — live work always shows
 * its individual pills so the rail gives feedback while processing; once the
 * last call lands it settles back to the one-line summary.
 */
export const toolGroupExpanded = (
  id: string,
  tools: ReadonlyArray<ToolBlock>,
  collapsed: ReadonlySet<string>,
): boolean => collapsed.has(id) || tools.some((t) => t.state === "running")

/**
 * The one-line summary a collapsed tool group shows, e.g.
 * `read · grep · edit  (3 tools, +5 -2)`. Names each call's verb (consecutive
 * repeats collapse to `read ×3`), counts the calls, rolls up the edit diffstat
 * parsed from the per-tool `+a/-b` detail, and surfaces any still-running /
 * failed counts so a fold never hides a problem.
 */
export const toolGroupSummary = (tools: ReadonlyArray<ToolBlock>): string => {
  const runs: Array<{ verb: string; n: number }> = []
  for (const t of tools) {
    const verb = toolVerb(t.toolName)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.verb === verb) last.n += 1
    else runs.push({ verb, n: 1 })
  }
  const verbs = runs.map((r) => (r.n > 1 ? `${r.verb} ×${r.n}` : r.verb)).join(" · ")

  let added = 0
  let removed = 0
  for (const t of tools) {
    const m = t.detail?.match(/\+(\d+)\/-(\d+)/)
    if (m) {
      added += Number(m[1])
      removed += Number(m[2])
    }
  }
  const meta: string[] = [`${tools.length} tools`]
  if (added > 0 || removed > 0) meta.push(`+${added} -${removed}`)
  const running = tools.filter((t) => t.state === "running").length
  const failed = tools.filter((t) => t.state === "error").length
  if (running > 0) meta.push(`${running} running`)
  if (failed > 0) meta.push(`${failed} failed`)
  return `${verbs}  (${meta.join(", ")})`
}

/**
 * Flatten the conversation into the navigable rows the fold cursor moves over —
 * one row per logical "paragraph". A `turn` yields a foldable header row (a `[`/
 * `]` message stop) then, when expanded, one row per body item (a `toolGroup` is
 * itself foldable); a `loose` run yields its body rows (the first a head); a
 * `checkpoint` is a single head row. Each `key` equals the rendered box id, so
 * the cursor tint + `scrollChildIntoView` line up; `{`/`}` step rows, `[`/`]`
 * jump head-to-head.
 */
export const buildConversationRows = (
  items: ReadonlyArray<ConversationItem>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<NavRow> => {
  const rows: NavRow[] = []
  const bodyRow = (b: BodyItem, head: boolean): NavRow =>
    b.kind === "toolGroup" ? { key: b.id, foldId: b.id, head } : { key: b.id, head }
  for (const item of items) {
    if (item.kind === "checkpoint") {
      rows.push({ key: item.id, head: true })
    } else if (item.kind === "turn") {
      rows.push({ key: item.id, foldId: item.id, head: true })
      if (!collapsed.has(item.id)) item.body.forEach((b) => rows.push(bodyRow(b, false)))
    } else {
      item.body.forEach((b, k) => rows.push(bodyRow(b, k === 0)))
    }
  }
  return rows
}

/**
 * Whether a unified diff is strict enough for the native `<diff>` renderer,
 * which validates hunk-header line counts and — on ANY mismatch — paints its
 * own "Error parsing diff: …" into the rail. A model-emitted diff is untrusted
 * input; when it doesn't hold up we render it as a plain dim block instead,
 * so a sloppy hunk header degrades to "less pretty", never to a parser error
 * leaking into the conversation.
 */
export const isRenderableDiff = (diff: string): boolean => {
  const lines = diff.split("\n")
  let i = 0
  let sawHunk = false
  while (i < lines.length && !lines[i]!.startsWith("@@")) i++
  while (i < lines.length) {
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]!)
    if (m === null) return false
    sawHunk = true
    let removed = 0
    let added = 0
    i++
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const c = lines[i]![0]
      if (c === "-") removed++
      else if (c === "+") added++
      else if (c === " " || lines[i] === "") {
        removed++
        added++
      } else if (c === "\\") {
        // "\ No newline at end of file" — counts toward neither side.
      } else return false
      i++
    }
    // trailing blank line from a final "\n" split shouldn't count
    if (lines[i - 1] === "" && i === lines.length) {
      removed--
      added--
    }
    const wantRemoved = m[1] === undefined ? 1 : Number(m[1])
    const wantAdded = m[2] === undefined ? 1 : Number(m[2])
    if (removed !== wantRemoved || added !== wantAdded) return false
  }
  return sawHunk
}
