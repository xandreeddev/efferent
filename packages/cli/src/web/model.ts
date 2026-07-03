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
import type {
  AgentChipView,
  ApprovalView,
  CanvasItemView,
  CanvasRegionView,
  WorkspaceItemView,
} from "@xandreed/web"
import { MAIN_REGION } from "@xandreed/web"
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
      /** The addressed component (`_main` for a whole-page op). */
      readonly region: string
      readonly op: CanvasOp
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
 *  same shape — `canvasReplay.ts` depends on that equivalence). `region` omitted
 *  ⇒ the call targets the whole page; present ⇒ it targets that one component. */
export interface CanvasEntry {
  readonly id: string
  readonly region?: string
  readonly title?: string
  readonly html: string
  readonly mode?: "replace" | "append" | "remove"
  readonly active?: boolean
}

/** What the fold did — the renderer maps each to an OOB fragment. A page is an
 *  ordered set of components; a render addresses one (or the whole page):
 *  - `new-page`      — a page id not seen before (render the whole section)
 *  - `rebuild`       — a whole-page (no-region) replace reset it (re-render the section)
 *  - `new-region`    — a component added to an existing page (append into its body)
 *  - `update-region` — a component's html changed (swap only that region div)
 *  - `remove-region` — a component was deleted (OOB-delete that region div) */
export type CanvasOp = "new-page" | "rebuild" | "new-region" | "update-region" | "remove-region"

const withTitle = (
  id: string,
  title: string | undefined,
  regions: ReadonlyArray<CanvasRegionView>,
): CanvasItemView => ({ id, ...(title !== undefined ? { title } : {}), regions })

/** The pure page merge — two-level (page → components), title sticky, insertion
 *  order preserved. `append` concatenates within the target region; a no-region
 *  replace rebuilds the page as a single `_main` component. Shared by the live
 *  fold (`putCanvas`) and history replay (`canvasReplay.ts`) so replay ≡
 *  live-fold is true by construction. */
export const mergeCanvasEntry = (
  canvas: ReadonlyArray<CanvasItemView>,
  entry: CanvasEntry,
): {
  readonly canvas: ReadonlyArray<CanvasItemView>
  readonly op: CanvasOp
  readonly region: string
  /** === (op === "new-page"); kept so `canvasFocus`/replay read it unchanged. */
  readonly isNew: boolean
} => {
  const mode = entry.mode ?? "replace"
  const region = entry.region ?? MAIN_REGION
  const at = canvas.findIndex((c) => c.id === entry.id)
  const prev = at === -1 ? undefined : canvas[at]
  const title = entry.title ?? prev?.title
  const replaceAt = (page: CanvasItemView): ReadonlyArray<CanvasItemView> => {
    const out = [...canvas]
    out[at] = page
    return out
  }

  // A brand-new page — one component to start.
  if (prev === undefined) {
    const page = withTitle(entry.id, title, [{ region, html: entry.html }])
    return { canvas: [...canvas, page], op: "new-page", region, isNew: true }
  }

  // A whole-page (no region) replace is a full rebuild — reset to one `_main`.
  if (entry.region === undefined && mode === "replace") {
    const page = withTitle(entry.id, title, [{ region: MAIN_REGION, html: entry.html }])
    return { canvas: replaceAt(page), op: "rebuild", region: MAIN_REGION, isNew: false }
  }

  // Otherwise operate on the addressed component within the existing page.
  const regions = [...prev.regions]
  const ri = regions.findIndex((r) => r.region === region)
  let op: CanvasOp
  if (mode === "remove") {
    if (ri !== -1) regions.splice(ri, 1)
    op = "remove-region"
  } else if (ri === -1) {
    regions.push({ region, html: entry.html })
    op = "new-region"
  } else {
    const html = mode === "append" ? `${regions[ri]!.html}\n${entry.html}` : entry.html
    regions[ri] = { region, html }
    op = "update-region"
  }
  return { canvas: replaceAt(withTitle(entry.id, title, regions)), op, region, isNew: false }
}

/** The focus rule: a NEW page opens focused unless `active: false`; an update
 *  stays in the background unless `active: true`. */
export const canvasFocus = (isNew: boolean, active: boolean | undefined): boolean =>
  isNew ? active !== false : active === true

/** Upsert a page (or one of its components); focus moves `activePage`. */
export const putCanvas = (
  m: WebModel,
  entry: CanvasEntry,
): { readonly model: WebModel; readonly patch: Patch } => {
  const { canvas, op, region, isNew } = mergeCanvasEntry(m.canvas, entry)
  const focus = canvasFocus(isNew, entry.active)
  return {
    model: { ...m, canvas, ...(focus ? { activePage: entry.id } : {}) },
    patch: { kind: "canvas", id: entry.id, region, op, focus },
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
