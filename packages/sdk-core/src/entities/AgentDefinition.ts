/**
 * An `AgentDefinition` is a reusable, git-shareable agent *role* — a markdown
 * file with YAML-ish frontmatter and a free-form body that becomes the role's
 * system-prompt instructions:
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness bugs and cleanups
 *   model: anthropic:claude-opus-4-8     # optional — omit to inherit main
 *   tools: read_file, grep, glob, ls     # optional allowlist — omit for all base tools
 *   ---
 *   You are a meticulous code reviewer. ...
 *
 * Discovery walks `.efferent/agents/*.md` from cwd up to home (closer-to-cwd
 * wins on name collisions), exactly like {@link Skill}. The `run_agent` tool's
 * `agent` parameter selects a definition by `name`; the role then runs with the
 * body as its scope instructions, its `tools` allowlist, and its `model`
 * override (when set). Definitions carry no executable code, so they travel as
 * plain files — checked into a repo or pulled from GitHub.
 */
export interface AgentDefinition {
  readonly name: string
  readonly description: string
  /**
   * Model override as `"<provider>:<modelId>"` (e.g. `"anthropic:claude-opus-4-8"`).
   * Absent ⇒ the role inherits the session's main model. The provider must be
   * logged in, else the spawn fails per-call with the usual auth error.
   */
  readonly model?: string
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
