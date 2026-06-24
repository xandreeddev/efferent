import type { AgentModelRole } from "./Model.js"

/**
 * An `AgentDefinition` is a reusable, git-shareable agent *role* — a markdown
 * file with YAML-ish frontmatter and a free-form body that becomes the role's
 * system-prompt instructions:
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness bugs and cleanups
 *   role: code                           # optional — general (default) | code
 *   tools: read_file, grep, glob, ls     # optional allowlist — omit for all base tools
 *   ---
 *   You are a meticulous code reviewer. ...
 *
 * Discovery walks `.efferent/agents/*.md` from cwd up to home (closer-to-cwd
 * wins on name collisions), exactly like {@link Skill}. The `run_agent` tool's
 * `agent` parameter selects a definition by `name`; the role then runs with the
 * body as its scope instructions, its `tools` allowlist, and its model `role`.
 * A definition customises the agent's prompt, tools, and which model TIER it
 * runs on (`general` | `code`) — but **never a specific model**: the human owns
 * which models back each role, so changing a model can't break a running fleet.
 * Definitions carry no executable code, so they travel as plain files — checked
 * into a repo or pulled from GitHub.
 */
export interface AgentDefinition {
  readonly name: string
  readonly description: string
  /**
   * Which model TIER this agent runs on — `"general"` (research / analysis /
   * orchestration) or `"code"` (writing code). Absent ⇒ `general`. Never a
   * specific model: a definition picks a role, the human configures the role's
   * model. A `run_agent({ role })` call overrides this per spawn.
   */
  readonly role?: AgentModelRole
  /**
   * Tool-name allowlist (e.g. `["read_file", "grep", "Bash"]`). Absent ⇒ the
   * full set of base coding tools. `run_agent` is excluded unless named here.
   */
  readonly tools?: ReadonlyArray<string>
  /** System-prompt body (frontmatter stripped). */
  readonly body: string
  /** Absolute path to the source `.md`. */
  readonly sourcePath: string
}
