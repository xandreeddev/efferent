import { type AgentMessage, type Checkpoint, handoffToMessage } from "@efferent/sdk-core"
import { glyph } from "./theme/index.js"

/**
 * The context viewer model. A conversation is partitioned by handoff
 * checkpoints into **archived** segments (the original messages a handoff
 * folded away — kept in the store, browsable, but NOT loaded into the model)
 * and a final **loaded** segment (what the model actually sees now: the latest
 * handoff summary + the messages since that fold).
 *
 * `buildContextView` is pure — the partitioning is unit-tested; rendering is
 * separate.
 */
export type ContextSegment =
  | {
      readonly kind: "archived"
      /** 1-based index of the handoff that folded this segment. */
      readonly handoffIndex: number
      /** This handoff's summary — what selecting the handoff loads in place of its messages. */
      readonly summary: string
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly kind: "loaded"
      /** The handoff summary the model loads in place of the archived msgs. */
      readonly summary: string | undefined
      readonly messages: ReadonlyArray<AgentMessage>
    }

export type ContextRowKind = "header" | "segment" | "summary" | "turn" | "message"

/**
 * The display payload for one context row, discriminated by kind — the OpenTUI
 * context viewer styles these fields itself (no baked-in ANSI). The side pane
 * cursors over the rows: `segment` rows are foldable; `messageIndex` lets Enter
 * jump the conversation to that message; `turnIndex`/`handoffIndex` mark the
 * select-and-build units.
 */
export type ContextRowDisplay =
  | {
      readonly kind: "header"
      readonly loaded: number
      readonly archived: number
      readonly hasFold: boolean
      readonly hasSummary: boolean
      readonly selectedCount: number
    }
  | {
      readonly kind: "segment"
      readonly archived: boolean
      readonly folded: boolean
      readonly selected: boolean
      readonly handoffIndex?: number
      /** For archived segments: how many real messages this handoff folded. */
      readonly foldedCount: number
    }
  | { readonly kind: "summary"; readonly text: string }
  | {
      readonly kind: "turn"
      readonly folded: boolean
      readonly selected: boolean
      readonly subject: string
      /** Message count in the turn (the trailing `·N`). */
      readonly steps: number
      readonly archived: boolean
    }
  | { readonly kind: "message"; readonly icon: string; readonly text: string }

/** The searchable text of one context row (for `/` search over the side pane). */
export const contextRowText = (row: ContextRowData): string => {
  const d = row.display
  switch (d.kind) {
    case "header":
      return ""
    case "segment":
      return d.archived ? `handoff ${d.handoffIndex ?? ""}` : "loaded context"
    case "summary":
      return d.text
    case "turn":
      return d.subject
    case "message":
      return d.text
  }
}

/** A context row with structured display data instead of a pre-styled label. */
export interface ContextRowData {
  readonly kind: ContextRowKind
  readonly depth: number
  readonly collapsible: boolean
  readonly groupId?: string
  readonly messageIndex?: number
  readonly turnIndex?: number
  readonly handoffIndex?: number
  readonly display: ContextRowDisplay
}

/**
 * Partition the full message list (ordered by position, dense from 0) using the
 * checkpoints' fold positions. Each checkpoint folds messages with
 * `position <= messagePosition`; the latest checkpoint's summary is what the
 * model currently loads.
 */
export const buildContextView = (
  messages: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
): ReadonlyArray<ContextSegment> => {
  const sorted = [...checkpoints].sort(
    (a, b) => a.messagePosition - b.messagePosition,
  )
  const segments: ContextSegment[] = []
  let prev = -1
  sorted.forEach((cp, i) => {
    // messages with index in (prev, cp.messagePosition] — index === position
    const slice = messages.slice(prev + 1, cp.messagePosition + 1)
    segments.push({
      kind: "archived",
      handoffIndex: i + 1,
      summary: cp.summary,
      messages: slice,
    })
    prev = cp.messagePosition
  })
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined
  segments.push({
    kind: "loaded",
    summary: latest?.summary,
    messages: messages.slice(prev + 1),
  })
  return segments
}

/** Count the real (non-summary) messages the model currently loads. */
const loadedMsgCount = (segments: ReadonlyArray<ContextSegment>): number =>
  segments.find((s) => s.kind === "loaded")?.messages.length ?? 0

const archivedMsgCount = (segments: ReadonlyArray<ContextSegment>): number =>
  segments
    .filter((s): s is Extract<ContextSegment, { kind: "archived" }> => s.kind === "archived")
    .reduce((n, s) => n + s.messages.length, 0)

/** One-line previews for a single message (assistant turns may yield several). */
const messageLines = (msg: AgentMessage): ReadonlyArray<{ icon: string; text: string }> => {
  if (msg.role === "user") {
    return [{ icon: glyph.msg.user, text: oneLine(msg.content) }]
  }
  if (msg.role === "assistant") {
    const out: { icon: string; text: string }[] = []
    for (const p of msg.content) {
      if (p.type === "text" || p.type === "reasoning") {
        const t = oneLine(p.text)
        if (t.length > 0) out.push({ icon: glyph.msg.assistant, text: t })
      } else if (p.type === "tool-call") {
        out.push({ icon: glyph.msg.tool, text: p.toolName })
      }
    }
    return out.length > 0 ? out : [{ icon: glyph.msg.assistant, text: "(tool calls)" }]
  }
  // tool results
  return msg.content.map((p) => ({
    icon: glyph.msg.result,
    text: `${p.toolName} ${p.isError ? "error" : "ok"}`,
  }))
}

const oneLine = (s: string): string =>
  s.replace(/\s+/g, " ").trim()

/**
 * Split a message list into **turns**: each `user` message starts a new turn,
 * carrying the assistant/tool replies that follow until the next `user`. A
 * leading non-user run (rare) forms the first turn. A turn is a complete
 * user→assistant→tool unit, so selecting whole turns keeps tool-call/result
 * pairs valid by construction.
 */
const groupTurns = (
  messages: ReadonlyArray<AgentMessage>,
): ReadonlyArray<ReadonlyArray<AgentMessage>> => {
  const turns: AgentMessage[][] = []
  let current: AgentMessage[] = []
  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) turns.push(current)
  return turns
}

/** One-line commit-style subject for a turn (its user prompt, else its first line). */
const turnSubject = (turn: ReadonlyArray<AgentMessage>): string => {
  const user = turn.find((m) => m.role === "user")
  if (user !== undefined && user.role === "user") return oneLine(user.content)
  const first = turn[0]
  const lines = first !== undefined ? messageLines(first) : []
  return lines[0]?.text ?? "(turn)"
}

/**
 * The `turn:<i>` group ids for every turn across all segments, in order — used
 * to seed the context viewer with all turns folded (a clean, selectable list).
 */
export const turnIdsOf = (segments: ReadonlyArray<ContextSegment>): ReadonlyArray<string> => {
  const ids: string[] = []
  let turnIdx = 0
  for (const seg of segments) {
    const n = groupTurns(seg.messages).length
    for (let i = 0; i < n; i++) ids.push(`turn:${turnIdx++}`)
  }
  return ids
}

/**
 * The contiguous `turnIndex` range each archived handoff owns — assigned the
 * same way `buildContextRows` walks segments/turns. Used to keep a handoff and
 * its own inner turns mutually exclusive when selecting (select the handoff →
 * its turns drop; select an inner turn → the handoff drops).
 */
export const archivedTurnRanges = (
  segments: ReadonlyArray<ContextSegment>,
): ReadonlyMap<number, { start: number; count: number }> => {
  const ranges = new Map<number, { start: number; count: number }>()
  let turnIdx = 0
  for (const seg of segments) {
    const count = groupTurns(seg.messages).length
    if (seg.kind === "archived") ranges.set(seg.handoffIndex, { start: turnIdx, count })
    turnIdx += count
  }
  return ranges
}

/** The archived handoff index owning `turnIndex`, or undefined (loaded turns own none). */
export const handoffOwningTurn = (
  segments: ReadonlyArray<ContextSegment>,
  turnIndex: number,
): number | undefined => {
  for (const [handoffIndex, { start, count }] of archivedTurnRanges(segments)) {
    if (turnIndex >= start && turnIndex < start + count) return handoffIndex
  }
  return undefined
}

/**
 * Collect the messages for the build seed, in conversation order — the picked
 * turns plus, for each selected handoff, a single `handoffToMessage(summary)`
 * standing in for that whole archived segment. Walks segments/turns the same way
 * `buildContextRows` assigns `turnIndex`, so the indices line up exactly; the
 * summary message lands as the prefix of its segment (matching `runAgent`'s
 * `[handoff prefix, …messages]` shape). A handoff and its own turns are kept
 * mutually exclusive at selection time, so they never both contribute.
 */
export const messagesForSelectedTurns = (
  segments: ReadonlyArray<ContextSegment>,
  selected: ReadonlySet<number>,
  selectedHandoffs: ReadonlySet<number> = new Set(),
): ReadonlyArray<AgentMessage> => {
  const out: AgentMessage[] = []
  let turnIdx = 0
  for (const seg of segments) {
    if (seg.kind === "archived" && selectedHandoffs.has(seg.handoffIndex)) {
      out.push(handoffToMessage(seg.summary))
    }
    for (const turn of groupTurns(seg.messages)) {
      if (selected.has(turnIdx)) out.push(...turn)
      turnIdx++
    }
  }
  return out
}

/**
 * Flatten the context segments into navigable rows with **structured** display
 * data (no ANSI), honouring `collapsed` (folded segment ids). Pure: the running
 * message index === conversation position (a multi-preview assistant message
 * shares one index), so a `message` row's `messageIndex` is a valid
 * `cursorToMessageIndex` jump target. `buildContextRows` renders these to ANSI;
 * the Solid/OpenTUI viewer styles the fields directly.
 */
export const buildContextRowsData = (
  segments: ReadonlyArray<ContextSegment>,
  collapsed: ReadonlySet<string>,
  selected: ReadonlySet<number> = new Set(),
  selectedHandoffs: ReadonlySet<number> = new Set(),
): ReadonlyArray<ContextRowData> => {
  const rows: ContextRowData[] = []
  const loaded = loadedMsgCount(segments)
  const archived = archivedMsgCount(segments)
  const hasFold = archived > 0
  const hasSummary = segments.some((s) => s.kind === "loaded" && Boolean(s.summary))

  rows.push({
    kind: "header",
    depth: 0,
    collapsible: false,
    display: {
      kind: "header",
      loaded,
      archived,
      hasFold,
      hasSummary,
      selectedCount: selected.size + selectedHandoffs.size,
    },
  })

  let msgIdx = 0
  let turnIdx = 0
  for (const seg of segments) {
    const isArchived = seg.kind === "archived"
    const gid = isArchived ? `seg:archived:${seg.handoffIndex}` : "seg:loaded"
    const segFolded = collapsed.has(gid)
    const turns = groupTurns(seg.messages)

    rows.push({
      kind: "segment",
      depth: 0,
      collapsible: true,
      groupId: gid,
      // Archived handoffs are a select-and-build unit: selecting one seeds the
      // build with its summary alone (the inner turns drop, mutually exclusive).
      ...(isArchived ? { handoffIndex: seg.handoffIndex } : {}),
      display: {
        kind: "segment",
        archived: isArchived,
        folded: segFolded,
        selected: isArchived && selectedHandoffs.has(seg.handoffIndex),
        ...(isArchived ? { handoffIndex: seg.handoffIndex } : {}),
        foldedCount: seg.messages.length,
      },
    })

    if (segFolded) {
      msgIdx += seg.messages.length
      turnIdx += turns.length
      continue
    }

    // The handoff summary — shown under both an archived segment (what selecting
    // the handoff grabs) and the loaded segment (the live cumulative summary).
    if (seg.summary) {
      rows.push({
        kind: "summary",
        depth: 1,
        collapsible: false,
        display: { kind: "summary", text: oneLine(seg.summary) },
      })
    }

    for (const turn of turns) {
      const tgid = `turn:${turnIdx}`
      const tFolded = collapsed.has(tgid)
      rows.push({
        kind: "turn",
        depth: 1,
        collapsible: true,
        groupId: tgid,
        turnIndex: turnIdx,
        messageIndex: msgIdx,
        display: {
          kind: "turn",
          folded: tFolded,
          selected: selected.has(turnIdx),
          subject: turnSubject(turn),
          steps: turn.length,
          archived: isArchived,
        },
      })

      if (tFolded) {
        msgIdx += turn.length
      } else {
        for (const msg of turn) {
          for (const ln of messageLines(msg)) {
            rows.push({
              kind: "message",
              depth: 2,
              collapsible: false,
              messageIndex: msgIdx,
              display: { kind: "message", icon: ln.icon, text: ln.text },
            })
          }
          msgIdx++
        }
      }
      turnIdx++
    }
  }
  return rows
}

