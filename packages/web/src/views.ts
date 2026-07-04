/**
 * Structural prop types — the contract between the cli driver and this
 * package's renderers. The driver adapts its view-models (ScrollbackBlock,
 * projections, events) onto these shapes; web renders, never interprets.
 * All types are plain data: no Effect, no Schema, no sdk-core.
 */

export interface AgentChipView {
  readonly nodeId: string
  readonly name: string
  readonly status: "running" | "ok" | "error"
  readonly toolUses: number
  readonly tokens: number
  readonly currentTool?: string
  readonly summary?: string
}

export type ChatBlockView =
  | {
      readonly kind: "message"
      /** Identity key — mirrors the TUI cache (`m:p<pos>:<u|a|r><ord>`). */
      readonly key: string
      readonly role: "user" | "assistant" | "reasoning"
      readonly markdown: string
    }
  | {
      readonly kind: "tool"
      /** Tool-call id — identical on the live stream and the projection. */
      readonly id: string
      /** Pre-formatted label (`read_file(src/x.ts)`) — the driver owns naming. */
      readonly label: string
      readonly state: "running" | "ok" | "error"
      readonly detail?: string
      readonly diff?: string
      readonly output?: string
      /** DOM id of this call's workspace card — clicking the pill opens the
       *  references drawer scrolled to it (`data-ref`, wired by app.js). */
      readonly refId?: string
    }
  | {
      readonly kind: "agents"
      readonly id: string
      readonly agents: ReadonlyArray<AgentChipView>
    }
  | {
      readonly kind: "line"
      readonly key: string
      readonly tone: "info" | "error" | "checkpoint"
      readonly text: string
    }

export interface PlanStepView {
  readonly text: string
  readonly status: "todo" | "active" | "done"
}

export interface PlanView {
  readonly steps: ReadonlyArray<PlanStepView>
}

export interface FileRefView {
  readonly path: string
  readonly content: string
  /** 1-based line number of `content`'s first line. */
  readonly startLine: number
  readonly highlight?: { readonly from: number; readonly to: number }
  readonly truncated?: boolean
}

export interface DiffCardView {
  /** Tool-call id (identity for the workspace stack). */
  readonly id: string
  readonly path: string
  readonly diff: string
  readonly added: number
  readonly removed: number
}

export interface SourceCardView {
  readonly id: string
  readonly kind: "fetch" | "search"
  readonly query?: string
  readonly url?: string
  readonly status?: number
  readonly answer?: string
  readonly sources: ReadonlyArray<{ readonly url: string; readonly title?: string }>
}

export type WorkspaceItemView =
  | { readonly kind: "plan"; readonly plan: PlanView }
  | { readonly kind: "file"; readonly file: FileRefView }
  | { readonly kind: "diff"; readonly diff: DiffCardView }
  | { readonly kind: "source"; readonly source: SourceCardView }

export interface ApprovalView {
  readonly tool: string
  readonly summary: string
  readonly cwd: string
  readonly ruleKey: string
  readonly reason?: string
  readonly folder?: string
}

export interface HeaderView {
  readonly sessionTitle: string
  readonly workspace: string
  readonly model: string
  readonly status: "idle" | "running" | "error"
  readonly agentsRunning: number
}

export interface QueueView {
  readonly items: ReadonlyArray<string>
}

/** The agent activity strip — the web's RunningLoader. `startedAt` (epoch ms)
 *  lets the client tick the elapsed time; the server never carries a clock. */
export interface ActivityView {
  readonly status: "idle" | "thinking" | "tool"
  /** What the agent is doing right now (`Read(src/x.ts)`, `retrying in 4s`…). */
  readonly label?: string
  readonly startedAt?: number
  readonly agentsRunning: number
}

/** The latest assistant reply, surfaced as a dismissible bubble above the
 *  composer (the transcript drawer holds the full history). */
export interface ReplyView {
  /** The message's identity key — a NEW key re-shows a dismissed bubble. */
  readonly key: string
  readonly markdown: string
}

/** The whole-page sentinel region: a `render_ui` with no `region` addresses
 *  this single component, so a plain page is one `_main` region and there is
 *  exactly one two-level fold path. Agent region ids are kebab-case and never
 *  start with `_`, so it can't collide. */
export const MAIN_REGION = "_main"

/** One component (region) of a page. A page is an ordered set of these; the
 *  agent addresses one by name via `render_ui.region`. */
export interface CanvasRegionView {
  /** The component id within the page (`render_ui.region`; `_main` = the
   *  whole-page component). */
  readonly region: string
  /** UNsanitized agent HTML for this component — `renderPageItem` sanitizes it. */
  readonly html: string
}

export interface CanvasItemView {
  /** The agent-chosen page id (`render_ui.id`) — one id = one page/tab. */
  readonly id: string
  /** The page's tab label. */
  readonly title?: string
  /** The page's components, in insertion order. A whole-page render is a single
   *  `_main` region. */
  readonly regions: ReadonlyArray<CanvasRegionView>
}

export interface ShellView {
  readonly header: HeaderView
  readonly blocks: ReadonlyArray<ChatBlockView>
  readonly workspace: ReadonlyArray<WorkspaceItemView>
  readonly plan: PlanView
  readonly canvas: ReadonlyArray<CanvasItemView>
  /** Which page is focused (`render_ui` id); defaults to the last page. */
  readonly activePage?: string
  readonly activity: ActivityView
  readonly reply?: ReplyView
  readonly queue: QueueView
  readonly approval?: ApprovalView
  /** The WS endpoint the shell connects to (may carry the auth token). */
  readonly wsUrl: string
}
