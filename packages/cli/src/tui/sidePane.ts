import { ansi, padRight, truncate, visibleLength } from "./terminal.js"

export interface AgentStackFrame {
  readonly name: string
  readonly currentTool?: string | undefined
  readonly status: "running" | "idle"
}

export interface SidePaneInstruction {
  readonly path: string
  readonly scope: string
}

export interface SidePaneState {
  readonly stack: ReadonlyArray<AgentStackFrame>
  readonly skillsLoaded: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<SidePaneInstruction>
}

export const emptySidePane: SidePaneState = {
  stack: [],
  skillsLoaded: [],
  instructions: [],
}

const STATUS_DOT = (status: AgentStackFrame["status"]): string =>
  status === "running"
    ? `${ansi.fgYellow}◉${ansi.reset}`
    : `${ansi.fgGreen}◉${ansi.reset}`

const homeDir = (() => {
  try {
    return process.env["HOME"] ?? ""
  } catch {
    return ""
  }
})()

const prettyPath = (p: string): string =>
  homeDir !== "" && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p

const sectionHeader = (label: string, count?: number): string => {
  const c = count !== undefined ? ` ${ansi.dim}(${count})${ansi.reset}` : ""
  return `${ansi.bold}${ansi.fgGray}${label}${ansi.reset}${c}`
}

const renderStack = (
  stack: ReadonlyArray<AgentStackFrame>,
  width: number,
): string[] => {
  const out: string[] = []
  if (stack.length === 0) {
    out.push(`${ansi.dim}(idle)${ansi.reset}`)
    return out
  }
  for (let i = 0; i < stack.length; i++) {
    const frame = stack[i]!
    const indent = "  ".repeat(i)
    const branch = i === 0 ? "" : `${ansi.dim}└─${ansi.reset} `
    const name = `${ansi.bold}${frame.name}${ansi.reset}`
    out.push(
      truncate(`${indent}${branch}${STATUS_DOT(frame.status)} ${name}`, width),
    )
    if (frame.currentTool !== undefined) {
      const toolLine = `${indent}   ${ansi.fgGray}${frame.currentTool}${ansi.reset}`
      out.push(truncate(toolLine, width))
    }
  }
  return out
}

const renderList = (
  items: ReadonlyArray<string>,
  width: number,
): string[] => {
  if (items.length === 0) {
    return [`${ansi.dim}(none)${ansi.reset}`]
  }
  return items.map((item) =>
    truncate(`${ansi.fgGray}·${ansi.reset} ${item}`, width),
  )
}

/**
 * Render the side pane: three sections (agent stack / skills / instructions)
 * separated by a blank line. Truncates per-row at `cols`; if the rendered
 * content exceeds `rows`, drops the tail and shows a "+N more" indicator.
 */
export const renderSidePane = (
  state: SidePaneState,
  rows: number,
  cols: number,
): string[] => {
  if (rows <= 0 || cols <= 0) return []
  const out: string[] = []
  out.push(sectionHeader("agent"))
  out.push(...renderStack(state.stack, cols))
  out.push("")
  out.push(sectionHeader("skills", state.skillsLoaded.length))
  out.push(...renderList(state.skillsLoaded, cols))
  out.push("")
  out.push(sectionHeader("instructions", state.instructions.length))
  out.push(
    ...renderList(
      state.instructions.map((i) => prettyPath(i.path)),
      cols,
    ),
  )

  const visible: string[] = []
  if (out.length <= rows) {
    visible.push(...out)
  } else {
    const trimmed = out.slice(0, rows - 1)
    const dropped = out.length - trimmed.length
    visible.push(...trimmed)
    visible.push(
      truncate(`${ansi.dim}+${dropped} more${ansi.reset}`, cols),
    )
  }
  while (visible.length < rows) visible.push("")
  return visible.map((line) => padRight(line, cols))
}

// Re-export so consumers don't reach into terminal.ts directly.
export { visibleLength }
