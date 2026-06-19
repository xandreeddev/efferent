import { dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@xandreed/sdk-core"
import { parseFrontmatter } from "./discoverScopeTree.js"

/**
 * Phase 2 — a **declarative tool** is a git-shareable tool defined in a file
 * (no code, no npm): a command/url template + named string params, run by one
 * generic `run_tool` handler. Two kinds:
 *  - `shell` — a command template run via the Shell port (gated by allowBash +
 *    the Approval port; param values are shell-escaped).
 *  - `http`  — a URL template fetched (GET) via the Http port.
 *
 *   ---
 *   name: count_lines
 *   description: Count lines across files matching a glob
 *   type: shell
 *   command: bash -lc 'wc -l ${glob}'
 *   params: glob: the glob to count (e.g. src/**\/*.ts)
 *   timeout: 30
 *   ---
 *
 * Param substitution replaces `${name}` in the template; values are escaped for
 * the target (shell-quote / URL-encode). Travels via git like agents/skills;
 * `:tools add github:…` imports them. MCP server refs are a separate, larger
 * client — deferred.
 */
export interface ToolParam {
  readonly name: string
  readonly description: string
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly kind: "shell" | "http"
  /** Command (shell) or URL (http) template with `${param}` placeholders. */
  readonly template: string
  readonly params: ReadonlyArray<ToolParam>
  /** Shell timeout in ms (from a `timeout:` seconds field); undefined → default. */
  readonly timeoutMs?: number
  readonly sourcePath: string
}

export const loadTools = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<ToolDefinition>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const seen = new Set<string>()
    const tools: ToolDefinition[] = []
    for (const dir of toolSearchPath(cwd, homeDir)) {
      const entries = yield* fs
        .list(dir, { recursive: false })
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<{ path: string; type: "file" | "dir" }>)))
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".md")) continue
        const absPath = isAbsolute(entry.path) ? entry.path : resolve(dir, entry.path)
        const read = yield* fs.read(absPath).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (read === undefined) continue
        const parsed = parseToolFile(read.content, absPath)
        if (parsed === undefined || seen.has(parsed.name)) continue
        seen.add(parsed.name)
        tools.push(parsed)
      }
    }
    tools.sort((a, b) => a.name.localeCompare(b.name))
    return tools
  })

const toolSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  let dir = cwd
  while (true) {
    const candidate = resolve(dir, ".efferent/tools")
    if (!seen.has(candidate)) {
      out.push(candidate)
      seen.add(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const home = resolve(homeDir, ".efferent/tools")
  if (!seen.has(home)) out.push(home)
  return out
}

/** Parse `params: a: desc one, b: desc two` into named params (flat, no YAML). */
const parseParams = (raw: string | undefined): ReadonlyArray<ToolParam> => {
  if (raw === undefined || raw.trim().length === 0) return []
  return raw
    .split(",")
    .map((part) => {
      const colon = part.indexOf(":")
      const name = (colon === -1 ? part : part.slice(0, colon)).trim()
      const description = colon === -1 ? "" : part.slice(colon + 1).trim()
      return { name, description }
    })
    .filter((p) => p.name.length > 0)
}

/** Exported so the git-import path can validate a downloaded file before writing. */
export const parseToolFile = (
  content: string,
  sourcePath: string,
): ToolDefinition | undefined => {
  const fm = parseFrontmatter(content)
  if (fm === undefined) return undefined
  const name = fm.fields["name"]
  const description = fm.fields["description"]
  if (name === undefined || description === undefined) return undefined
  const kind: "shell" | "http" = fm.fields["type"] === "http" ? "http" : "shell"
  const template = kind === "http" ? fm.fields["url"] : fm.fields["command"]
  if (template === undefined || template.trim().length === 0) return undefined
  const timeoutSec = fm.fields["timeout"] !== undefined ? Number(fm.fields["timeout"]) : undefined
  return {
    name,
    description,
    kind,
    template,
    params: parseParams(fm.fields["params"]),
    ...(timeoutSec !== undefined && Number.isFinite(timeoutSec) && timeoutSec > 0
      ? { timeoutMs: Math.floor(timeoutSec * 1000) }
      : {}),
    sourcePath,
  }
}

/** POSIX single-quote escape — safe to interpolate a value into a shell command. */
export const shellEscape = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`

/**
 * Substitute `${param}` placeholders in a template with escaped arg values.
 * Returns the filled string + the names of any placeholders with no arg (the
 * caller treats a non-empty `missing` as a validation failure). Unknown args
 * are ignored; a `$${` escapes a literal `${`.
 */
export const substituteTemplate = (
  template: string,
  args: Readonly<Record<string, string>>,
  escape: (v: string) => string,
): { readonly filled: string; readonly missing: ReadonlyArray<string> } => {
  const missing: string[] = []
  const filled = template.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
    const v = args[name]
    if (v === undefined) {
      missing.push(name)
      return ""
    }
    return escape(v)
  })
  return { filled, missing }
}
