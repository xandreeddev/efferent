/**
 * The single source for a `# Tools` prompt block. {@link renderToolsFor} renders
 * ONE line per tool the role actually has — so a prompt can never advertise a
 * tool the role's toolkit lacks (the old static blocks told the read-only
 * `architect` it could `write_file`/`run_agent`, the `researcher` that it had
 * `Bash`, etc.). Both the root coder prompt and the spawned sub-agent prompt
 * (`scopeAgent`) render from this, keyed on the role's real tool names.
 *
 * The line text is curated here (one place), scope-neutral — write/edit/bash
 * confinement is stated once in the prompt's `# Scope` section, not repeated per
 * tool. A coverage test asserts every tool the runtime can grant a sub-agent has
 * a blurb, so adding a tool without one fails CI.
 */

/** name → the single prompt line shown when the role holds that tool. */
const TOOL_BLURBS: Record<string, string> = {
  read_file:
    "read_file({ path, offset?, limit? }) — read a file's contents (line-numbered). Use offset/limit on big files.",
  write_file:
    "write_file({ path, content }) — create or fully replace a file. Prefer edit_file for changes to existing files.",
  edit_file:
    "edit_file({ path, edits: [{ oldText, newText }] }) — apply targeted in-place edits; oldText must match exactly (whitespace included).",
  Bash: "Bash({ command, timeout?, run_in_background? }) — run a shell command.",
  bash_output:
    "bash_output({ processId, sinceCursor? }) — read the incremental output of a background Bash process.",
  kill_bash: "kill_bash({ processId }) — kill a background Bash process.",
  grep: "grep({ pattern, dir?, flags?, context? }) — regex search across files.",
  glob: "glob({ pattern, dir? }) — find files by name pattern (e.g. '**/*.ts').",
  ls: "ls({ path?, recursive? }) — list a directory.",
  read_skill: "read_skill({ name }) — read the full body of a named skill (see Skills).",
  read_memory:
    "read_memory({ name }) — read a project-knowledge record's full body (see Project knowledge).",
  remember:
    "remember({ title, content }) — record a durable decision/convention/gotcha into the workspace knowledge layer.",
  web_fetch:
    "web_fetch({ url, maxBytes? }) — fetch an http(s) URL as readable text. Only URLs you were given or a tool surfaced.",
  search_web:
    "search_web({ query }) — search the web; returns a synthesized answer plus source URLs.",
  update_plan:
    "update_plan({ steps: [{ step, status }] }) — your working plan as a user-visible checklist; each call replaces it whole.",
  session_start:
    "session_start({ command? }) — start a detached interactive terminal session (tmux) for a TUI/REPL.",
  session_send: "session_send({ session, keys }) — send keystrokes to an interactive session.",
  session_read: "session_read({ session }) — capture an interactive session's screen.",
  session_kill: "session_kill({ session }) — kill an interactive session.",
  session_list: "session_list({}) — list interactive sessions.",
  run_agent:
    "run_agent({ name, folder, task, role?, agent?, instructions? }) — spawn a background sub-agent for focused, folder-scoped work; returns immediately (see Sub-agents).",
  wait_for_agents:
    "wait_for_agents({ nodeIds?, timeoutSeconds? }) — gather spawned agents' results without blocking (see Coordination).",
  send_message:
    "send_message({ to, content }) — message a running agent by its nodeId; it reads at its next turn.",
  blackboard_post: "blackboard_post({ note }) — post to the shared fleet scratchpad.",
  blackboard_read: "blackboard_read({ limit? }) — read the shared fleet scratchpad.",
  run_tool: "run_tool({ name, args }) — run a project-defined custom tool (see Custom tools).",
  schedule:
    "schedule({ cron, task, folder?, agent? }) — schedule a future/recurring run (5-field cron).",
  list_scheduled_jobs: "list_scheduled_jobs({}) — list scheduled jobs.",
  cancel_scheduled_job: "cancel_scheduled_job({ id }) — cancel a scheduled job.",
}

/**
 * The full tool set a generic (no-role) sub-agent is granted — the base coding
 * tools + comms + `run_agent` (mirrors `genericToolkit` in buildScopeRuntime).
 * Used as the tool list for SCOPE.md-discovered folder agents, which run on the
 * generic toolkit. A test asserts this stays in sync with the real toolkit.
 */
export const GENERIC_AGENT_TOOL_NAMES: ReadonlyArray<string> = [
  "read_file",
  "write_file",
  "edit_file",
  "Bash",
  "bash_output",
  "kill_bash",
  "grep",
  "glob",
  "ls",
  "read_skill",
  "read_memory",
  "remember",
  "web_fetch",
  "search_web",
  "update_plan",
  "session_start",
  "session_send",
  "session_read",
  "session_kill",
  "session_list",
  "send_message",
  "blackboard_post",
  "blackboard_read",
  "wait_for_agents",
  "run_tool",
  "schedule",
  "list_scheduled_jobs",
  "cancel_scheduled_job",
  "run_agent",
]

/** True iff every given name has a blurb (the coverage-test predicate). */
export const hasBlurb = (name: string): boolean => TOOL_BLURBS[name] !== undefined

/**
 * Render the `# Tools` section for exactly the tools `toolNames` lists, in order.
 * A name with no blurb is dropped (never invented); an empty result yields "".
 */
export const renderToolsFor = (toolNames: ReadonlyArray<string>): string => {
  const lines = toolNames
    .map((n) => TOOL_BLURBS[n])
    .filter((l): l is string => l !== undefined)
    .map((l) => `- ${l}`)
  return lines.length === 0 ? "" : `# Tools\n${lines.join("\n")}\n`
}
