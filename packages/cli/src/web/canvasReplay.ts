/**
 * Rebuild the generative-UI pages from the PERSISTED message log. `render_ui`
 * is a tool, so every call's full args ({ id, title?, html, mode?, active? })
 * live in the ConversationStore as assistant tool-call parts — no separate
 * canvas storage exists or is needed. Replaying them through the SAME merge
 * the live fold uses (`mergeCanvasEntry`) makes replay ≡ live-fold true by
 * construction, so pages survive a driver restart and `--resume`.
 *
 * Replay policy: every render_ui tool-CALL replays; results are ignored. The
 * handler has no failure path a page could vanish through (`rendered: false`
 * only occurs off-web, where the tool isn't offered), and a dangling call
 * from an interrupted turn is still honest content. Malformed args (no
 * string id/html) are skipped structurally — never a crash.
 *
 * Known limit (accepted): the seed walks the ACTIVE window (`SessionState.log`),
 * so pages rendered before a handoff fold are gone after a reseed — the live
 * in-memory model keeps them until the process ends. The durable fix is a
 * canvas snapshot carried on the checkpoint; until then the model simply
 * re-renders on request.
 */
import type { AgentMessage } from "@xandreed/sdk-core"
import type { CanvasItemView } from "@xandreed/web"
import { canvasFocus, mergeCanvasEntry, type CanvasEntry } from "./model.js"

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** Structurally parse one render_ui tool-call input (the toolDescribe
 *  discipline: `unknown` in, typed entry or nothing out). */
const parseEntry = (input: unknown): CanvasEntry | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const a = input as Record<string, unknown>
  const id = str(a.id)
  const html = str(a.html)
  if (id === undefined || id.length === 0 || html === undefined) return undefined
  const mode = a.mode === "append" ? "append" : "replace"
  return {
    id,
    html,
    mode,
    ...(str(a.title) !== undefined ? { title: str(a.title) as string } : {}),
    ...(typeof a.active === "boolean" ? { active: a.active } : {}),
  }
}

export interface ReplayedCanvas {
  readonly canvas: ReadonlyArray<CanvasItemView>
  readonly activePage: string | undefined
}

/** Fold every persisted render_ui call, oldest → newest (store order ⊇ part
 *  emission order, identical to the live event order). */
export const replayCanvas = (history: ReadonlyArray<AgentMessage>): ReplayedCanvas => {
  let canvas: ReadonlyArray<CanvasItemView> = []
  let activePage: string | undefined
  for (const msg of history) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (typeof part !== "object" || part === null) continue
      const p = part as { type?: unknown; toolName?: unknown; input?: unknown }
      if (p.type !== "tool-call" || p.toolName !== "render_ui") continue
      const entry = parseEntry(p.input)
      if (entry === undefined) continue
      const merged = mergeCanvasEntry(canvas, entry)
      canvas = merged.canvas
      if (canvasFocus(merged.isNew, entry.active)) activePage = entry.id
    }
  }
  return { canvas, activePage }
}
