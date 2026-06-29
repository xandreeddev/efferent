import { codingToolkit } from "@xandreed/sdk-core"

/**
 * Eval COVERAGE MAP — which suite(s) behaviorally exercise each coding tool.
 *
 * The data-engineering point: a capability shipped without an eval is invisible
 * until something breaks (the background/tmux tools shipped exactly that way).
 * This map + its test make coverage a tracked, gated property — adding a tool to
 * `codingToolkit` WITHOUT a coverage decision fails `coverage.test.ts`. An empty
 * array means "considered, deliberately not eval-covered yet" (a documented gap,
 * not an oversight).
 */
export const TOOL_COVERAGE: Record<string, ReadonlyArray<string>> = {
  read_file: ["tool-selection", "coder-edit", "whole-task", "repo-tasks"],
  write_file: ["whole-task", "repo-tasks"],
  edit_file: ["coder-edit", "whole-task", "repo-tasks"],
  Bash: ["whole-task", "repo-tasks", "background-shell"],
  bash_output: ["background-shell"],
  kill_bash: ["background-shell"],
  grep: ["tool-selection", "whole-task"],
  glob: ["whole-task"],
  ls: ["tool-selection"],
  read_skill: [],
  read_memory: [],
  remember: ["distill"],
  web_fetch: [],
  search_web: [],
  update_plan: ["whole-task", "background-shell"],
  // tmux interactive sessions — the eval env has no tmux (NoopTerminalSession),
  // so these are deliberately uncovered here; their adapter has unit tests.
  session_start: [],
  session_send: [],
  session_read: [],
  session_kill: [],
  session_list: [],
}

/** Every tool registered in the base coding toolkit. */
export const allCodingToolNames = (): ReadonlyArray<string> =>
  Object.keys(codingToolkit.tools)

/** Tools registered in the toolkit but ABSENT from the coverage map — a new tool
 *  added without a coverage decision. The gate fails on any of these. */
export const unmappedTools = (): ReadonlyArray<string> =>
  allCodingToolNames().filter((t) => !(t in TOOL_COVERAGE))

/** Tools mapped but with NO covering suite — documented gaps (allowed, surfaced). */
export const uncoveredTools = (): ReadonlyArray<string> =>
  allCodingToolNames().filter((t) => (TOOL_COVERAGE[t] ?? []).length === 0)

/** Coverage map entries for tools that no longer exist — stale, should be pruned. */
export const staleCoverageEntries = (): ReadonlyArray<string> => {
  const names = new Set(allCodingToolNames())
  return Object.keys(TOOL_COVERAGE).filter((t) => !names.has(t))
}
