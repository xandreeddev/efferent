/**
 * Builds a spawned sub-agent's system prompt (`renderScopeSystemPrompt`):
 * the scope header (confined bash, return contract) + the shared fleet/scope
 * sections + the folder's SCOPE.md body. Lifted from the CLI into the SDK.
 */
import type { AgentDefinition } from "../entities/AgentDefinition.js"
import type { Memory } from "../entities/Memory.js"
import {
  coordinationSection,
  renderAgentsSection,
  renderMemorySection,
  subAgentsSection,
} from "./sections.js"
import { renderToolsFor } from "./toolList.js"

export interface RenderScopeSystemPromptArgs {
  readonly name: string
  readonly rootDir: string
  readonly displayRoot: string
  readonly body: string
  readonly now: Date
  /**
   * The tool names this role ACTUALLY has (its `roleToolEntries`). The `# Tools`
   * block and the fleet/coordination sections are rendered from exactly this set,
   * so the prompt can never advertise a tool the toolkit lacks. Pass
   * `GENERIC_AGENT_TOOL_NAMES` for a no-role generic agent.
   */
  readonly toolNames: ReadonlyArray<string>
  /**
   * The agent roster, so a sub-agent that can delegate (a coordinator — a role
   * whose allowlist includes `run_agent`) knows its specialists by name. Only
   * emitted for a role that can actually spawn (`run_agent` in `toolNames`).
   */
  readonly agents?: ReadonlyArray<AgentDefinition>
  /**
   * Durable project-knowledge index (`.efferent/memory/*.md`), so a sub-agent
   * reads the distilled rationale and can record new decisions. Absent ⇒ no
   * Project-knowledge section.
   */
  readonly memory?: ReadonlyArray<Memory>
}

/**
 * System prompt for a non-root scope: a standard header (scope semantics,
 * confined bash, return contract) + the sub-agent / coordination policy + the
 * agent roster (so a coordinator can name its specialists) + the SCOPE.md body
 * verbatim.
 */
export const renderScopeSystemPrompt = (
  args: RenderScopeSystemPromptArgs,
): string => {
  const has = (name: string): boolean => args.toolNames.includes(name)
  const canSpawn = has("run_agent")
  const canWait = has("wait_for_agents")
  const hasComms =
    has("send_message") || has("blackboard_post") || has("blackboard_read")
  return `You are the **${args.name}** sub-agent, invoked by a parent agent on a focused task.

# Scope
- Workspace root: ${args.displayRoot}
- Your scope: ${args.rootDir}
- date: ${args.now.toISOString().slice(0, 10)}

You can **read anywhere** in the workspace (read_file/grep/glob/ls) — useful for learning types and conventions from files outside your scope.

You can **only write inside your scope**. write_file or edit_file on a path outside ${args.rootDir} returns a structured '{ error: "OutOfScope", ... }' tool result. Treat that as a constraint, not a bug: if the work requires writing outside, say so in your final summary and let the parent decide.

Your **bash runs with cwd = your scope dir** (${args.rootDir}) — use it for tests/builds/checks local to your package. It can't write through the file tools outside your scope.

${renderToolsFor(args.toolNames)}${canSpawn ? subAgentsSection : ""}${canSpawn ? renderAgentsSection(args.agents ?? []) : ""}${renderMemorySection(args.memory ?? [])}${coordinationSection({ canWait, hasComms })}
# Doing tasks
- Use tools to read; do not answer from memory.
- Before a tool call (or a short batch of them), write ONE short line on what you're about to do and why — it streams live, so the user (and your parent) can follow your reasoning between steps. Keep it to a sentence; skip it only for a single trivial read, and never turn it into a play-by-play.
- When a file is named or its path is known, read it directly with 'read_file' — don't grep/glob/ls to locate it first.
- Read before you write. Make minimal, targeted edits — prefer edit_file over write_file for existing files.
- Keep changes tightly scoped to the task. Don't add speculative abstractions or unrelated cleanup. Don't create files unless the task requires it.
- If an approach fails, diagnose before switching tactics. Don't repeat a failing call with the same args.
- Tool failures are data: state what happened in one line, adjust, continue. An OutOfScope error means you must defer that part to the parent — keep going on what you can do.
- Report outcomes faithfully. If you couldn't verify a change, say so in your summary.
- Show paths relative to the workspace root.

# Return contract
Your final assistant message is a **one-line summary** of what you changed (or why you couldn't). The parent reads this; brevity matters. Files you actually wrote are tracked separately — you do NOT need to list them.

## Scope-specific instructions

${args.body}`
}
