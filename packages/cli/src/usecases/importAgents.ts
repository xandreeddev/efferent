import { basename, resolve } from "node:path"
import { Data, Effect } from "effect"
import { FileSystem, Http, parseToolFile } from "@xandreed/sdk-core"
import { parseAgentFile } from "./loadAgents.js"

/** A git-import failed at the spec/network/listing level (per-file problems are
 *  collected in `skipped`, not thrown). */
export class ImportAgentsError extends Data.TaggedError("ImportAgentsError")<{
  readonly message: string
}> {}

export interface ImportResult {
  /** Role names written into `.efferent/agents/`. */
  readonly written: ReadonlyArray<string>
  /** `"<file>: <reason>"` for files fetched but not written (bad frontmatter, HTTP error, too large). */
  readonly skipped: ReadonlyArray<string>
}

/** Agent `.md` files are small; cap fetches well above that and treat hitting
 *  the cap as probable truncation (the Http port truncates silently). */
const MAX_BYTES = 256_000

interface ParsedSpec {
  readonly owner: string
  readonly repo: string
  /** Path within the repo — a `.md` file or a directory (empty = repo root). */
  readonly path: string
  readonly ref: string
}

/** Parse `github:owner/repo[/path][@ref]`. Returns undefined when malformed. */
const parseSpec = (spec: string): ParsedSpec | undefined => {
  let s = spec.trim()
  if (s.startsWith("github:")) s = s.slice("github:".length)
  let ref = "HEAD"
  const at = s.lastIndexOf("@")
  if (at > 0) {
    ref = s.slice(at + 1).trim()
    s = s.slice(0, at)
  }
  const parts = s.split("/").filter((p) => p.length > 0)
  if (parts.length < 2) return undefined
  return {
    owner: parts[0]!,
    repo: parts[1]!,
    path: parts.slice(2).join("/"),
    ref: ref.length > 0 ? ref : "HEAD",
  }
}

interface ContentsEntry {
  readonly name?: unknown
  readonly type?: unknown
  readonly download_url?: unknown
}

const safeJsonArray = (s: string): ReadonlyArray<ContentsEntry> | undefined => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as ReadonlyArray<ContentsEntry>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Pull agent-definition `.md` files from GitHub into `destDir`
 * (`<cwd>/.efferent/agents`). Two forms:
 *   - `github:owner/repo/path/to/file.md` → one raw file.
 *   - `github:owner/repo[/dir]`           → every `.md` in that dir (GitHub
 *                                            contents API), repo root if no dir.
 * `@ref` selects a branch/tag/sha (default `HEAD`). Each file is validated as a
 * real {@link AgentDefinition} (name+description frontmatter) before writing;
 * bad files are reported in `skipped`, not written. No git, no npm — just the
 * `Http` + `FileSystem` ports.
 */
/**
 * Generic GitHub import: fetch `.md` definitions (a single file or every `.md`
 * in a directory) and write the valid ones into `destDir`. `validate` returns
 * the canonical name to file it under (used as `<name>.md`), or undefined to
 * skip it. Shared by the agent + tool importers.
 */
export const importDefsFromGithub = (
  spec: string,
  destDir: string,
  validate: (content: string) => string | undefined,
): Effect.Effect<ImportResult, ImportAgentsError, Http | FileSystem> =>
  Effect.gen(function* () {
    const parsed = parseSpec(spec)
    if (parsed === undefined) {
      return yield* Effect.fail(
        new ImportAgentsError({
          message: `not a github spec: '${spec}' — use github:owner/repo[/path][@ref]`,
        }),
      )
    }
    const { owner, repo, path, ref } = parsed
    const http = yield* Http
    const fs = yield* FileSystem
    const written: string[] = []
    const skipped: string[] = []

    const fetchAndWrite = (rawUrl: string, filename: string) =>
      Effect.gen(function* () {
        const res = yield* http
          .get(rawUrl, { maxBytes: MAX_BYTES })
          .pipe(Effect.mapError((e) => new ImportAgentsError({ message: e.message })))
        if (res.status !== 200) {
          skipped.push(`${filename}: HTTP ${res.status}`)
          return
        }
        if (res.body.length >= MAX_BYTES) {
          skipped.push(`${filename}: too large (likely truncated)`)
          return
        }
        const name = validate(res.body)
        if (name === undefined) {
          skipped.push(`${filename}: invalid (missing required frontmatter)`)
          return
        }
        const dest = resolve(destDir, `${name}.md`)
        yield* fs.write(dest, res.body).pipe(
          Effect.mapError(
            (e) =>
              new ImportAgentsError({
                message: `write ${dest}: ${e._tag === "PermissionDenied" ? `permission denied (${e.path})` : e.message}`,
              }),
          ),
        )
        written.push(name)
      })

    if (path.endsWith(".md")) {
      yield* fetchAndWrite(
        `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
        basename(path),
      )
    } else {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
      const res = yield* http
        .get(apiUrl, { maxBytes: MAX_BYTES })
        .pipe(Effect.mapError((e) => new ImportAgentsError({ message: e.message })))
      if (res.status !== 200) {
        return yield* Effect.fail(
          new ImportAgentsError({
            message: `GitHub API HTTP ${res.status} for ${owner}/${repo}/${path || "(root)"}`,
          }),
        )
      }
      const entries = safeJsonArray(res.body)
      if (entries === undefined) {
        return yield* Effect.fail(
          new ImportAgentsError({ message: "couldn't parse the GitHub listing (directory too large?)" }),
        )
      }
      const mdFiles = entries.filter(
        (e): e is { name: string; type: string; download_url: string } =>
          e.type === "file" &&
          typeof e.name === "string" &&
          e.name.endsWith(".md") &&
          typeof e.download_url === "string",
      )
      if (mdFiles.length === 0) {
        return yield* Effect.fail(
          new ImportAgentsError({
            message: `no .md files at ${owner}/${repo}/${path || "(root)"}`,
          }),
        )
      }
      for (const e of mdFiles) yield* fetchAndWrite(e.download_url, e.name)
    }

    return { written, skipped }
  })

/** Import agent ROLES from GitHub into `.efferent/agents/`. */
export const importAgentsFromGithub = (
  spec: string,
  destDir: string,
): Effect.Effect<ImportResult, ImportAgentsError, Http | FileSystem> =>
  importDefsFromGithub(spec, destDir, (content) => parseAgentFile(content, "")?.name)

/** Import declarative TOOLS from GitHub into `.efferent/tools/`. */
export const importToolsFromGithub = (
  spec: string,
  destDir: string,
): Effect.Effect<ImportResult, ImportAgentsError, Http | FileSystem> =>
  importDefsFromGithub(spec, destDir, (content) => parseToolFile(content, "")?.name)
