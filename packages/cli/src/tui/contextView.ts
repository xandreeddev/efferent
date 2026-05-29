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
 * Render the context view as a tree: archived segments dim (the originals,
 * not loaded), the loaded segment bright with the handoff summary marked `✦`.
 * Returns full-width lines; the side pane windows/zooms them.
 */
export const renderContextView = (
  segments: ReadonlyArray<ContextSegment>,
  cols: number,
): string[] => {
  const out: string[] = []
  const loaded = loadedMsgCount(segments)
  const archived = archivedMsgCount(segments)
  const hasFold = archived > 0

  // Header: the split, so the replacement is legible at a glance.
  out.push(
    `${ansi.bold}${ansi.fgGray}── context ──${ansi.reset} ` +
      (hasFold
        ? `${ansi.dim}loaded ${ansi.reset}${ansi.fgGreen}${loaded} msg${loaded === 1 ? "" : "s"}${
            segments.some((s) => s.kind === "loaded" && s.summary) ? " + summary" : ""
          }${ansi.reset}${ansi.dim} · archived ${archived}${ansi.reset}`
        : `${ansi.fgGreen}${loaded} msg${loaded === 1 ? "" : "s"}${ansi.reset}${ansi.dim} loaded · no handoff yet${ansi.reset}`),
  )
  out.push("")

  for (const seg of segments) {
    if (seg.kind === "archived") {
      const n = seg.messages.length
      out.push(
        `${ansi.fgBrightMagenta}⚑${ansi.reset}${ansi.dim} handoff #${seg.handoffIndex} · ${n} msg${n === 1 ? "" : "s"} folded (not loaded)${ansi.reset}`,
      )
      for (const msg of seg.messages) {
        for (const ln of messageLines(msg)) {
          out.push(`${ansi.dim}   ${ln.icon} ${ln.text}${ansi.reset}`)
        }
      }
      out.push("")
    } else {
      out.push(`${ansi.fgGreen}●${ansi.reset}${ansi.bold} loaded context${ansi.reset}`)
      if (seg.summary !== undefined) {
        out.push(
          `${ansi.fgBrightMagenta}   ✦ ${ansi.reset}${ansi.dim}${oneLine(seg.summary)}${ansi.reset}`,
        )
      }
      for (const msg of seg.messages) {
        for (const ln of messageLines(msg)) {
          out.push(`   ${ln.icon} ${ln.text}`)
        }
      }
    }
  }

  return out.map((l) => padRight(truncate(l, cols), cols))
}
