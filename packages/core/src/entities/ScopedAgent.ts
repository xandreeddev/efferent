/**
 * A `ScopedAgent` is a sub-agent bound to a directory. Registered by a
 * `SCOPE.md` file at that directory's root (frontmatter `name` +
 * `description`; body becomes the scope-specific portion of the
 * sub-agent's system prompt).
 *
 * Invoked by the parent coder agent via a `delegate_to_<name>` tool.
 * The parent gets back a one-line summary + the list of files the
 * sub-agent actually wrote. The sub-agent's internal turns are opaque
 * to the parent.
 *
 * Scope semantics:
 *   - **Reads** are unrestricted — the sub-agent can `read_file`,
 *     `grep`, `glob`, `ls` anywhere in the workspace.
 *   - **Writes** are restricted — `write_file` and `edit_file` reject
 *     any path outside `rootDir` with `AgentToolError(OutOfScope)`.
 *   - **No bash.** Tests and migrations stay on the parent.
 */
export interface ScopedAgentConfig {
  /** Slug used as the delegation tool name (`delegate_to_<name>`). */
  readonly name: string
  /** One-line summary, used by the parent's prompt to describe when to delegate. */
  readonly description: string
  /** Absolute path; writes by this sub-agent must stay within this prefix. */
  readonly rootDir: string
  /** Display anchor for relative paths in tool results — usually the workspace cwd. */
  readonly displayRoot: string
  /** Full system prompt: standard scoped-agent header + the SCOPE.md body verbatim. */
  readonly systemPrompt: string
}
