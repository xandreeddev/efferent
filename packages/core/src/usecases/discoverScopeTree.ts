import { basename, dirname, isAbsolute, resolve, sep } from "node:path"
import { Effect } from "effect"
import type { Scope } from "../entities/Scope.js"
import { renderScopeSystemPrompt } from "../prompts/coder.js"
import { FileSystem, type DirEntry } from "../ports/FileSystem.js"

/**
 * Walk bounds. SCOPE.md discovery runs at every boot, so the walk must stay
 * cheap even in a degenerate workspace — efferent launched at `/` (a
 * container's default workdir) otherwise scans the entire filesystem and is
 * OOM-killed before printing anything. Hidden directories and dependency
 * trees can't meaningfully carry scopes; the caps turn the worst case into a
 * bounded partial discovery instead of a hang.
 */
const WALK_MAX_DEPTH = 8
const WALK_MAX_DIRS = 10_000

/** Directories never descended into: hidden trees + dependency trees. */
const prunedDir = (name: string): boolean => name.startsWith(".") || name === "node_modules"

/**
 * Discover the workspace's **scope tree** from `SCOPE.md` files.
 *
 * The tree mirrors the directory tree: a `SCOPE.md` in a subdirectory
 * becomes a child of the nearest enclosing scope (another `SCOPE.md`'s dir,
 * else the root). The workspace root is always scope #0 — built from a
 * root `SCOPE.md` body if present (its instructions), else synthesised with
 * the built-in coder prompt. `makeRootPrompt` owns assembling that root
 * prompt (so this use case stays prompt-agnostic); child prompts are
 * rendered here via `renderScopeSystemPrompt`.
 *
 * Each child `SCOPE.md`:
 *   - frontmatter: `name` + `description` — inert metadata now (sub-agents
 *     are spawned via the generic `run_agent` tool, not per-scope tools).
 *     Required; malformed/dupe-name files are skipped.
 *   - body: ambient folder context — injected verbatim into any sub-agent
 *     scoped to that folder (`getScopePromptBody`).
 *   - location: the containing directory is the writeable/bash scope.
 *
 * Never fails — an unreadable workspace yields a bare root with no children
 * (identical to a plain workspace-wide agent).
 */
export const discoverScopeTree = (
  workspaceRoot: string,
  makeRootPrompt: (
    children: ReadonlyArray<Scope>,
    body: string | undefined,
  ) => string,
  now: Date = new Date(),
  bounds?: { readonly maxDepth?: number; readonly maxDirs?: number },
): Effect.Effect<Scope, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const maxDepth = bounds?.maxDepth ?? WALK_MAX_DEPTH
    const maxDirs = bounds?.maxDirs ?? WALK_MAX_DIRS

    // Bounded BFS, one non-recursive listing per directory. A listing
    // failure (EACCES, vanished dir) just prunes that branch — same
    // resilience the old recursive `list` walk had, but with depth/size
    // caps so a huge workspace can't stall the boot. BFS order also means
    // shallow scopes win the first-name-seen dedupe below.
    const files: string[] = []
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [
      { dir: workspaceRoot, depth: 0 },
    ]
    let scanned = 0
    while (queue.length > 0 && scanned < maxDirs) {
      const { dir, depth } = queue.shift()!
      scanned++
      const entries = yield* fs
        .list(dir)
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DirEntry>)))
      for (const e of entries) {
        const abs = isAbsolute(e.path) ? e.path : resolve(dir, e.path)
        if (e.type === "file") {
          if (basename(abs) === "SCOPE.md") files.push(abs)
        } else if (depth < maxDepth && !prunedDir(basename(abs))) {
          queue.push({ dir: abs, depth: depth + 1 })
        }
      }
    }

    const seen = new Set<string>()
    const raws: RawScope[] = []
    let rootBody: string | undefined

    for (const rel of files) {
      const abs = isAbsolute(rel) ? rel : resolve(workspaceRoot, rel)
      const read = yield* fs
        .read(abs)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (read === undefined) continue
      const dir = dirname(abs)
      const parsed = parseScopeFile(read.content)

      // Root SCOPE.md: its body (or whole content) seeds the root prompt;
      // frontmatter name/description are not required at the root.
      if (dir === workspaceRoot) {
        rootBody = parsed !== undefined ? parsed.body : read.content
        continue
      }
      if (parsed === undefined) continue
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)
      raws.push({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        dir,
        children: [],
      })
    }

    // Nearest-ancestor assignment: each scope attaches to the deepest other
    // scope whose dir strictly contains it; otherwise to the root.
    const rootRaws: RawScope[] = []
    for (const r of raws) {
      let best: RawScope | undefined
      for (const p of raws) {
        if (p === r) continue
        if (isStrictAncestor(p.dir, r.dir)) {
          if (best === undefined || p.dir.length > best.dir.length) best = p
        }
      }
      if (best !== undefined) best.children.push(r)
      else rootRaws.push(r)
    }

    const toScope = (raw: RawScope): Scope => {
      const children = raw.children
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toScope)
      return {
        name: raw.name,
        description: raw.description,
        rootDir: raw.dir,
        displayRoot: workspaceRoot,
        systemPrompt: renderScopeSystemPrompt({
          name: raw.name,
          rootDir: raw.dir,
          displayRoot: workspaceRoot,
          body: raw.body,
          now,
        }),
        isRoot: false,
        enforceWrite: true,
        children,
      }
    }

    const rootChildren = rootRaws
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toScope)

    return {
      name: "root",
      description: "the whole workspace",
      rootDir: workspaceRoot,
      displayRoot: workspaceRoot,
      systemPrompt: makeRootPrompt(rootChildren, rootBody),
      isRoot: true,
      enforceWrite: false,
      children: rootChildren,
    } satisfies Scope
  })

interface RawScope {
  name: string
  description: string
  body: string
  dir: string
  children: RawScope[]
}

/** True when `anc` is a strict ancestor directory of `d`. */
const isStrictAncestor = (anc: string, d: string): boolean =>
  d.startsWith(anc.endsWith(sep) ? anc : anc + sep)

interface ParsedScope {
  readonly name: string
  readonly description: string
  /** Body with frontmatter stripped. */
  readonly body: string
}

/**
 * Same frontmatter conventions as skills: a `---\n…\n---` fence at the top,
 * `key: value` lines inside. Required keys: `name`, `description`.
 */
const parseScopeFile = (content: string): ParsedScope | undefined => {
  if (!content.startsWith("---")) return undefined
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return undefined
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return undefined
  const frontmatter = afterFirstFence.slice(0, closeIndex)
  const body = afterFirstFence.slice(closeIndex + 4).replace(/^\n+/, "")

  const fields: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
    fields[key] = value
  }
  const name = fields["name"]
  const description = fields["description"]
  if (name === undefined || description === undefined) return undefined
  return { name, description, body }
}

/**
 * Ambient folder context: the body of a folder's `SCOPE.md`, to be injected
 * into any agent that runs scoped to that folder. This is `SCOPE.md`'s new
 * role — "extra context for the folder" rather than "defines a delegatable
 * agent". Frontmatter (if present) is stripped; a bodyless / missing /
 * unreadable `SCOPE.md` yields `undefined`.
 */
export const getScopePromptBody = (
  folder: string,
): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* fs
      .read(resolve(folder, "SCOPE.md"))
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (read === undefined) return undefined
    const parsed = parseScopeFile(read.content)
    const body = parsed !== undefined ? parsed.body : read.content
    return body.trim().length > 0 ? body : undefined
  })
