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
 * Sub-agents are spawned with the generic `run_agent` tool (any folder,
 * on demand) — a scope is no longer a pre-wired delegation target. The
 * tree's remaining roles: the root scope anchors the workspace prompt +
 * binding, and a folder's `SCOPE.md` body is ambient context injected
 * into any sub-agent that runs scoped there (`getScopePromptBody`).
 *
 * Pure value (`node:path` only); no IO. Built by `discoverScopeTree`,
 * turned into a runnable `{ toolkit, handlerLayer }` by `buildScopeRuntime`.
 */
export interface Scope {
  /** Frontmatter `name` slug — inert metadata now. Root: `"root"`. */
  readonly name: string
  /** Frontmatter one-liner — inert metadata now (kept for prompts/UI hints). */
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
  /** Direct children — nested `SCOPE.md` directories under this one. */
  readonly children: ReadonlyArray<Scope>
}
