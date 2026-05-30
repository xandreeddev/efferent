import type { AgentMessage, Checkpoint } from "@agent/core"
import { ansi, padRight, truncate } from "./terminal.js"

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
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly kind: "loaded"
      /** The handoff summary the model loads in place of the archived msgs. */
      readonly summary: string | undefined
      readonly messages: ReadonlyArray<AgentMessage>
    }

/**
 * A flat, navigable row of the context tree (one visual line). The side pane
 * cursors over these: `segment` rows are foldable fold-handles; `message` rows
 * carry the conversation `messageIndex` so Enter can jump the conversation
 * cursor to that message. `label` is pre-styled (icon + one-line text).
 */
export type ContextRowKind = "header" | "segment" | "summary" | "message"
export interface ContextRow {
  readonly kind: ContextRowKind
  readonly depth: number
  readonly label: string
  readonly collapsible: boolean
  readonly groupId?: string
  readonly messageIndex?: number
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
    segments.push({ kind: "archived", handoffIndex: i + 1, messages: slice })
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
    return [{ icon: "❯", text: oneLine(msg.content) }]
  }
  if (msg.role === "assistant") {
    const out: { icon: string; text: string }[] = []
    for (const p of msg.content) {
      if (p.type === "text" || p.type === "reasoning") {
        const t = oneLine(p.text)
        if (t.length > 0) out.push({ icon: "●", text: t })
      } else if (p.type === "tool-call") {
        out.push({ icon: "⚙", text: p.toolName })
      }
    }
    return out.length > 0 ? out : [{ icon: "●", text: "(tool calls)" }]
  }
  // tool results
  return msg.content.map((p) => ({
    icon: "↳",
    text: `${p.toolName} ${p.isError ? "error" : "ok"}`,
  }))
}

const oneLine = (s: string): string =>
  s.replace(/\s+/g, " ").trim()

/**
 * Flatten the context segments into navigable rows, honouring `collapsed`
 * (folded segment ids). Pure: the running message index === conversation
 * position (a multi-preview assistant message shares one index), so a
 * `message` row's `messageIndex` is a valid `cursorToMessageIndex` jump target.
 */
export const buildContextRows = (
  segments: ReadonlyArray<ContextSegment>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<ContextRow> => {
  const rows: ContextRow[] = []
  const loaded = loadedMsgCount(segments)
  const archived = archivedMsgCount(segments)
  const hasFold = archived > 0
  const hasSummary = segments.some((s) => s.kind === "loaded" && s.summary)

  rows.push({
    kind: "header",
    depth: 0,
    collapsible: false,
    label:
      `${ansi.bold}${ansi.fgGray}── context ──${ansi.reset} ` +
      (hasFold
        ? `${ansi.dim}loaded ${ansi.reset}${ansi.fgGreen}${loaded}${ansi.reset}${ansi.dim}${hasSummary ? " + ✦" : ""} · archived ${archived}${ansi.reset}`
        : `${ansi.fgGreen}${loaded} msg${loaded === 1 ? "" : "s"}${ansi.reset}${ansi.dim} · no handoff yet${ansi.reset}`),
  })

  let msgIdx = 0
  for (const seg of segments) {
    if (seg.kind === "archived") {
      const gid = `seg:archived:${seg.handoffIndex}`
      const folded = collapsed.has(gid)
      const n = seg.messages.length
      rows.push({
        kind: "segment",
        depth: 0,
        collapsible: true,
        groupId: gid,
        label: `${ansi.fgGray}${folded ? "▸" : "▾"}${ansi.reset} ${ansi.fgBrightMagenta}⚑${ansi.reset}${ansi.dim} handoff #${seg.handoffIndex} · ${n} msg${n === 1 ? "" : "s"} folded${ansi.reset}`,
      })
      if (folded) {
        msgIdx += n
      } else {
        for (const msg of seg.messages) {
          for (const ln of messageLines(msg)) {
            rows.push({
              kind: "message",
              depth: 1,
              collapsible: false,
              messageIndex: msgIdx,
              label: `${ansi.dim}   ${ln.icon} ${ln.text}${ansi.reset}`,
            })
          }
          msgIdx++
        }
      }
    } else {
      const gid = "seg:loaded"
      const folded = collapsed.has(gid)
      rows.push({
        kind: "segment",
        depth: 0,
        collapsible: true,
        groupId: gid,
        label: `${ansi.fgGray}${folded ? "▸" : "▾"}${ansi.reset} ${ansi.fgGreen}●${ansi.reset}${ansi.bold} loaded context${ansi.reset}`,
      })
      if (folded) {
        msgIdx += seg.messages.length
      } else {
        if (seg.summary !== undefined) {
          rows.push({
            kind: "summary",
            depth: 1,
            collapsible: false,
            label: `   ${ansi.fgBrightMagenta}✦${ansi.reset} ${ansi.dim}${oneLine(seg.summary)}${ansi.reset}`,
          })
        }
        for (const msg of seg.messages) {
          for (const ln of messageLines(msg)) {
            rows.push({
              kind: "message",
              depth: 1,
              collapsible: false,
              messageIndex: msgIdx,
              label: `   ${ln.icon} ${ln.text}`,
            })
          }
          msgIdx++
        }
      }
    }
  }
  return rows
}

/**
 * Render the context rows to full-width lines. `cursorIndex` (when `focused`)
 * gets the bright cursor-line tint — the side pane's hardware block cursor
 * sits on the same row.
 */
export const renderContextView = (
  rows: ReadonlyArray<ContextRow>,
  cols: number,
  cursorIndex = -1,
  focused = false,
): string[] =>
  rows.map((r, i) => {
    const line = padRight(truncate(r.label, cols), cols)
    if (focused && i === cursorIndex) {
      return (
        ansi.bgCursorLine +
        line.split(ansi.reset).join(ansi.reset + ansi.bgCursorLine) +
        ansi.reset
      )
    }
    return line
  })
