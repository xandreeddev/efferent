/**
 * A `Scope` is a node in the scope tree — the core organising abstraction
 * for the coding agent. The tree mirrors the directory tree of `SCOPE.md`
 * files in the workspace:
 *
 *   - The **root** scope is always present (scope #0). It owns the whole
 *     workspace, edits anywhere, and orchestrates the children below it.
 *     Its instructions come from a workspace-root `SCOPE.md` (body appended
 *     to the built-in coder prompt) or, when absent, the built-in prompt.
 *   - Each **child** scope owns the directory its `SCOPE.md` lives in. It
 *     gets the full toolset, but `write_file`/`edit_file` and `bash` are
 *     confined to its `rootDir`; reads (`read_file`/`grep`/`glob`/`ls`)
 *     stay workspace-wide so a worker can learn from sibling packages.
 *
 * A parent reaches its *direct* children through `delegate_to_<name>`
 * tools; a child's toolkit recursively carries delegate tools for *its*
 * own children. Delegation is ephemeral — the sub-agent runs in a fresh
 * context window (just the task + its scope instructions), keeping noise
 * off the orchestrating thread. It returns a one-line summary plus the
 * files it actually wrote.
 *
 * Pure value (`node:path` only); no IO. Built by `discoverScopeTree`,
 * turned into a runnable `{ toolkit, handlerLayer }` by `buildScopeRuntime`.
 */
export interface Scope {
  /** Slug used as the delegation tool name (`delegate_to_<name>`). Root: `"root"`. */
  readonly name: string
  /** One-line summary used by the parent's prompt to describe when to delegate. */
  readonly description: string
  /** Absolute path; writes + bash by this scope are confined here. Root: the workspace. */
  readonly rootDir: string
  /** Absolute anchor for relative-path display in tool results — the workspace root. */
  readonly displayRoot: string
  /** Full system prompt: scope header + `SCOPE.md` body (root: built-in coder prompt). */
  readonly systemPrompt: string
  /** True for the always-present root scope. */
  readonly isRoot: boolean
  /** Whether writes are confined to `rootDir`. False for the root (owns everything). */
  readonly enforceWrite: boolean
  /** Direct children — the scopes this one can `delegate_to_<name>`. */
  readonly children: ReadonlyArray<Scope>
}
