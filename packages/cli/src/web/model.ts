/**
 * The web driver's framework-free session model — the keyed-cache discipline
 * of `cli/state/conversation.ts` ported off Solid: every writer addresses a
 * block by stable identity, so live events, local echoes and full re-renders
 * upsert to one entry (and one DOM node). Pure data + pure helpers; the
 * reducer (`reduce.ts`) is the only writer, the renderer (`render.ts`) the
 * only reader.
 *
 * NO Solid / OpenTUI imports anywhere under `src/web/` (the presentation/
 * purity rule).
 */
import type { PlanStep } from "@xandreed/sdk-core"
import type { ScrollbackBlock } from "../cli/presentation/conversation.js"
import type { AgentChipView, ApprovalView, CanvasItemView, WorkspaceItemView } from "@xandreed/web"
import type { PhaseState } from "@xandreed/sdk-core"

/** A rail block plus its minted identity (transients get `t:<n>` keys — the
 *  DOM needs an id where the TUI could stay keyless). */
export interface WebBlock {
  readonly key: string
  readonly block: ScrollbackBlock
}

/** The fixed identity of the single live agents container block. */
export const AGENTS_BLOCK_KEY = "agents:live"

export interface WebModel {
  readonly blocks: ReadonlyArray<WebBlock>
  readonly plan: ReadonlyArray<PlanStep>
  /** Workspace cards (file/diff/source — never plan; it has its own slot). */
  readonly workspace: ReadonlyArray<WorkspaceItemView>
  /** The generative-UI PAGES, in creation order. */
  readonly canvas: ReadonlyArray<CanvasItemView>
  /** The focused page (render_ui id) — moves only on focus events. */
  readonly activePage: string | undefined
  readonly agents: ReadonlyArray<AgentChipView>
  readonly approval: ApprovalView | undefined
  readonly phase: PhaseState
  /** What the root is doing right now (the activity strip's label). */
  readonly activity: { readonly label?: string }
  /** Epoch ms the current busy stretch started (idle ⇒ undefined). */
  readonly activitySince: number | undefined
  /** Tool-pill key → its workspace card's DOM id (click-to-open refs). */
  readonly refIds: Readonly<Record<string, string>>
  readonly queue: ReadonlyArray<string>
  /** Monotonic counter minting transient block keys. */
  readonly seq: number
}

export const emptyModel = (phase: PhaseState): WebModel => ({
  blocks: [],
  plan: [],
  workspace: [],
  canvas: [],
  activePage: undefined,
  agents: [],
  approval: undefined,
  phase,
  activity: {},
  activitySince: undefined,
  refIds: {},
  queue: [],
  seq: 0,
})

/** What changed — the renderer turns each patch into one OOB fragment. */
export type Patch =
  | { readonly kind: "block"; readonly key: string; readonly isNew: boolean }
  | { readonly kind: "plan" }
  | { readonly kind: "workspace"; readonly index: number; readonly isNew: boolean }
  | {
      readonly kind: "canvas"
      readonly id: string
      readonly isNew: boolean
      /** Pull the user to this page (a new page, or an update with active:true). */
      readonly focus: boolean
    }
  | { readonly kind: "approval" }
  | { readonly kind: "queue" }
  | { readonly kind: "header" }
  | { readonly kind: "activity" }

/** A block's inherent identity (mirror of `state/conversation.ts`): tools and
 *  the agents container key on `id`, messages on their stamped `key`;
 *  transients have none (the model mints one). */
export const identityOf = (b: ScrollbackBlock): string | undefined => {
  if (b.kind === "tool" || b.kind === "agents") return b.id
  if (b.kind === "user" || b.kind === "assistant" || b.kind === "reasoning") return b.key
  return undefined
}

/** Upsert a block: replace in place by key, else append. Returns the patch. */
export const putBlock = (
  m: WebModel,
  block: ScrollbackBlock,
): { readonly model: WebModel; readonly patch: Patch } => {
  const inherent = identityOf(block)
  const key = inherent ?? `t:${m.seq + 1}`
  const seq = inherent === undefined ? m.seq + 1 : m.seq
  const at = m.blocks.findIndex((b) => b.key === key)
  if (at === -1) {
    return {
      model: { ...m, seq, blocks: [...m.blocks, { key, block }] },
      patch: { kind: "block", key, isNew: true },
    }
  }
  const blocks = [...m.blocks]
  blocks[at] = { key, block }
  return { model: { ...m, seq, blocks }, patch: { kind: "block", key, isNew: false } }
}

/** Patch a tool pill by its id (state/detail/diff/output on completion). */
export const patchToolBlock = (
  m: WebModel,
  id: string,
  patch: Partial<Extract<ScrollbackBlock, { kind: "tool" }>>,
): { readonly model: WebModel; readonly patch: Patch | undefined } => {
  const at = m.blocks.findIndex((b) => b.key === id && b.block.kind === "tool")
  const existing = at === -1 ? undefined : m.blocks[at]
  if (existing === undefined || existing.block.kind !== "tool") return { model: m, patch: undefined }
  const blocks = [...m.blocks]
  blocks[at] = { key: id, block: { ...existing.block, ...patch } }
  return { model: { ...m, blocks }, patch: { kind: "block", key: id, isNew: false } }
}

/** Identity for a workspace card: files by path (re-reads refresh in place),
 *  diffs/sources by their tool-call id. */
export const workspaceIdentity = (item: WorkspaceItemView): string => {
  switch (item.kind) {
    case "plan":
      return "plan"
    case "file":
      return `file:${item.file.path}`
    case "diff":
      return `diff:${item.diff.id}`
    case "source":
      return `src:${item.source.id}`
  }
}

/** Upsert a workspace card (plan routes to the model's plan instead). */
export const putWorkspaceItem = (
  m: WebModel,
  item: WorkspaceItemView,
): { readonly model: WebModel; readonly patch: Patch } => {
  if (item.kind === "plan") {
    return {
      model: { ...m, plan: item.plan.steps.map((s) => ({ step: s.text, status: planStatusBack(s.status) })) },
      patch: { kind: "plan" },
    }
  }
  const id = workspaceIdentity(item)
  const at = m.workspace.findIndex((w) => workspaceIdentity(w) === id)
  if (at === -1) {
    return {
      model: { ...m, workspace: [...m.workspace, item] },
      patch: { kind: "workspace", index: m.workspace.length, isNew: true },
    }
  }
  const workspace = [...m.workspace]
  workspace[at] = item
  return { model: { ...m, workspace }, patch: { kind: "workspace", index: at, isNew: false } }
}

const planStatusBack = (s: "todo" | "active" | "done"): PlanStep["status"] =>
  s === "todo" ? "pending" : s

/** One render_ui payload (the live event AND a replayed tool-call carry the
 *  same shape — `canvasReplay.ts` depends on that equivalence). */
export interface CanvasEntry {
  readonly id: string
  readonly title?: string
  readonly html: string
  readonly mode: "replace" | "append"
  readonly active?: boolean
}

/** The pure page merge — title sticky, `append` concatenates, insertion order
 *  preserved. Shared by the live fold (`putCanvas`) and the history replay
 *  (`canvasReplay.ts`) so replay ≡ live-fold is true by construction. */
export const mergeCanvasEntry = (
  canvas: ReadonlyArray<CanvasItemView>,
  entry: CanvasEntry,
): { readonly canvas: ReadonlyArray<CanvasItemView>; readonly isNew: boolean } => {
  const at = canvas.findIndex((c) => c.id === entry.id)
  const prev = at === -1 ? undefined : canvas[at]
  const next: CanvasItemView = {
    id: entry.id,
    ...(entry.title !== undefined
      ? { title: entry.title }
      : prev?.title !== undefined
        ? { title: prev.title }
        : {}),
    html:
      entry.mode === "append" && prev !== undefined ? `${prev.html}\n${entry.html}` : entry.html,
  }
  if (at === -1) return { canvas: [...canvas, next], isNew: true }
  const out = [...canvas]
  out[at] = next
  return { canvas: out, isNew: false }
}

/** The focus rule: a NEW page opens focused unless `active: false`; an update
 *  stays in the background unless `active: true`. */
export const canvasFocus = (isNew: boolean, active: boolean | undefined): boolean =>
  isNew ? active !== false : active === true

/** Upsert a page; focus moves `activePage`. */
export const putCanvas = (
  m: WebModel,
  entry: CanvasEntry,
): { readonly model: WebModel; readonly patch: Patch } => {
  const { canvas, isNew } = mergeCanvasEntry(m.canvas, entry)
  const focus = canvasFocus(isNew, entry.active)
  return {
    model: { ...m, canvas, ...(focus ? { activePage: entry.id } : {}) },
    patch: { kind: "canvas", id: entry.id, isNew, focus },
  }
}

/** Upsert one agent chip by nodeId (add on first sight). */
export const putChip = (
  m: WebModel,
  nodeId: string,
  f: (chip: AgentChipView | undefined) => AgentChipView,
): WebModel => {
  const at = m.agents.findIndex((a) => a.nodeId === nodeId)
  if (at === -1) return { ...m, agents: [...m.agents, f(undefined)] }
  const agents = [...m.agents]
  const current = agents[at]
  agents[at] = f(current)
  return { ...m, agents }
}
