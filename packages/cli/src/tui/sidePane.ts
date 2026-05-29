import { ansi, padRight, truncate, SPINNER_FRAMES } from "./terminal.js"
import { emptyTree, type ExecutionTree, type TreeNode } from "./executionTree.js"
import { type ContextSegment, renderContextView } from "./contextView.js"

export interface SidePaneInstruction {
  readonly path: string
  readonly scope: string
}

export interface SidePaneState {
  readonly tree: ExecutionTree
  readonly skillsLoaded: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<SidePaneInstruction>
  /** Which view the side pane shows: the live agent stack, or the context viewer. */
  readonly view: "stack" | "context"
  /** Context-viewer segments (built from list + checkpoints); shown when view==="context". */
  readonly context?: ReadonlyArray<ContextSegment>
}

export const emptySidePane: SidePaneState = {
  tree: emptyTree,
  skillsLoaded: [],
  instructions: [],
  view: "stack",
}

const homeDir = (() => {
  try {
    return process.env["HOME"] ?? ""
  } catch {
    return ""
  }
})()

const prettyPath = (p: string): string =>
  homeDir !== "" && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

const sectionHeader = (label: string, count?: number): string => {
  const c = count !== undefined ? ` ${ansi.dim}(${count})${ansi.reset}` : ""
  return `${ansi.bold}${ansi.fgGray}── ${label} ──${ansi.reset}${c}`
}

const statusGlyph = (node: TreeNode, spinnerFrame: number): string => {
  if (node.status === "running") {
    return `${ansi.fgYellow}${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}${ansi.reset}`
  }
  if (node.status === "error") return `${ansi.fgRed}✗${ansi.reset}`
  return `${ansi.fgGreen}✓${ansi.reset}`
}

const containerGlyph = (node: TreeNode): string => {
  const color =
    node.status === "running"
      ? ansi.fgYellow
      : node.status === "error"
        ? ansi.fgRed
        : ansi.fgGray
  return `${color}▾${ansi.reset}`
}

const renderNode = (
  node: TreeNode,
  depth: number,
  spinnerFrame: number,
  now: number,
  width: number,
  out: string[],
): void => {
  const indent = "  ".repeat(depth)
  const isContainer = node.kind === "turn" || node.kind === "subagent"
  const glyph = isContainer ? containerGlyph(node) : statusGlyph(node, spinnerFrame)
  const detail =
    node.detail !== undefined ? ` ${ansi.dim}${node.detail}${ansi.reset}` : ""
  let line = `${indent}${glyph} ${node.label}${detail}`

  if (isContainer) {
    const dur = fmtDur((node.endedAt ?? now) - node.startedAt)
    line += ` ${ansi.dim}${dur}${ansi.reset}`
  }
  out.push(truncate(line, width))

  for (const child of node.children) {
    renderNode(child, depth + 1, spinnerFrame, now, width, out)
  }
}

const renderTreeLines = (
  tree: ExecutionTree,
  spinnerFrame: number,
  now: number,
  width: number,
): string[] => {
  if (tree.roots.length === 0) {
    return [`${ansi.dim}(idle)${ansi.reset}`]
  }
  const out: string[] = []
  for (const root of tree.roots) {
    renderNode(root, 0, spinnerFrame, now, width, out)
  }
  return out
}

const renderListSection = (
  label: string,
  items: ReadonlyArray<string>,
  width: number,
): string[] => {
  const out = [sectionHeader(label, items.length)]
  if (items.length === 0) {
    out.push(`${ansi.dim}(none)${ansi.reset}`)
  } else {
    for (const item of items) {
      out.push(truncate(`${ansi.fgGray}·${ansi.reset} ${item}`, width))
    }
  }
  return out
}

/**
 * Render the side pane: the live execution tree on top (tail-windowed so
 * the newest activity stays visible), with skills + instructions sections
 * pinned below. Truncates per row at `cols`.
 */
export const renderSidePane = (
  state: SidePaneState,
  rows: number,
  cols: number,
  spinnerFrame = 0,
  now: number = Date.now(),
): string[] => {
  if (rows <= 0 || cols <= 0) return []

  // Context view: the message tree + handoff replacement. Tail-windowed like
  // the stack tree (newest/loaded stays visible); `z` zooms for the full read.
  if (state.view === "context") {
    const lines =
      state.context !== undefined && state.context.length > 0
        ? renderContextView(state.context, cols)
        : [`${ansi.dim}(no conversation yet)${ansi.reset}`]
    const window =
      lines.length > rows ? lines.slice(lines.length - rows) : lines
    const out = [...window]
    while (out.length < rows) out.push("")
    return out.slice(0, rows).map((line) => padRight(line, cols))
  }

  const sections: string[] = ["", ...renderListSection("skills", state.skillsLoaded, cols)]
  sections.push(
    "",
    ...renderListSection(
      "instructions",
      state.instructions.map((i) => prettyPath(i.path)),
      cols,
    ),
  )

  // Reserve up to half the pane for the bottom sections; the tree takes
  // the rest and shows its tail (newest nodes) when it overflows.
  const sectionsBudget = Math.min(sections.length, Math.floor(rows / 2))
  const shownSections = sections.slice(0, sectionsBudget)
  const treeRows = Math.max(0, rows - shownSections.length)

  const treeLines = renderTreeLines(state.tree, spinnerFrame, now, cols)
  const treeWindow =
    treeLines.length > treeRows
      ? treeLines.slice(treeLines.length - treeRows)
      : treeLines

  const out: string[] = []
  out.push(...treeWindow)
  while (out.length < treeRows) out.push("")
  out.push(...shownSections)
  while (out.length < rows) out.push("")
  return out.slice(0, rows).map((line) => padRight(line, cols))
}
