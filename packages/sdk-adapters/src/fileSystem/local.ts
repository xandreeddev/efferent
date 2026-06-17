import * as fs from "node:fs"
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import { Effect, Layer } from "effect"
import {
  FileNotFound,
  FileSystem,
  FileSystemError,
  NotADirectory,
  PermissionDenied,
} from "@xandreed/sdk-core"

const errCode = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : ""

const errMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const fsError = (cause: unknown, where: string) =>
  new FileSystemError({
    cause,
    message: `${where} failed: ${errMessage(cause)}`,
  })

const tryReadError = (cause: unknown, path: string) => {
  switch (errCode(cause)) {
    case "ENOENT":
      return new FileNotFound({ path })
    case "EACCES":
    case "EPERM":
      return new PermissionDenied({ path })
    default:
      return fsError(cause, `read ${path}`)
  }
}

const tryWriteError = (cause: unknown, path: string) => {
  switch (errCode(cause)) {
    case "EACCES":
    case "EPERM":
      return new PermissionDenied({ path })
    default:
      return fsError(cause, `write ${path}`)
  }
}

const tryListError = (cause: unknown, path: string) => {
  switch (errCode(cause)) {
    case "ENOENT":
      return new FileNotFound({ path })
    case "ENOTDIR":
      return new NotADirectory({ path })
    default:
      return fsError(cause, `list ${path}`)
  }
}

const readWithRange = (path: string, opts?: { offset?: number; limit?: number }) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => tryReadError(cause, path),
  }).pipe(
    Effect.map((buf) => {
      const all = buf.split("\n")
      const total = all.length
      const startIdx =
        opts?.offset !== undefined ? Math.max(0, opts.offset - 1) : 0
      const endIdx =
        opts?.limit !== undefined ? Math.min(total, startIdx + opts.limit) : total
      const slice = all.slice(startIdx, endIdx)
      return {
        content: slice.join("\n"),
        truncated: startIdx > 0 || endIdx < total,
        totalLines: total,
      }
    }),
  )

const writeFileEffect = (path: string, content: string) =>
  Effect.gen(function* () {
    const dir = dirname(path)
    yield* Effect.tryPromise({
      try: () => mkdir(dir, { recursive: true }),
      catch: (cause) => tryWriteError(cause, dir),
    })
    yield* Effect.tryPromise({
      try: () => writeFile(path, content, "utf8"),
      catch: (cause) => tryWriteError(cause, path),
    })
  })

interface DirEntryOut {
  readonly path: string
  readonly type: "file" | "dir"
}

const walkDir = (
  path: string,
  recursive: boolean,
): Effect.Effect<
  ReadonlyArray<DirEntryOut>,
  FileNotFound | NotADirectory | FileSystemError
> =>
  Effect.gen(function* () {
    const out: DirEntryOut[] = []
    const walk = (
      dir: string,
      isRoot: boolean,
    ): Effect.Effect<
      void,
      FileNotFound | NotADirectory | FileSystemError
    > =>
      Effect.gen(function* () {
        // EACCES on a SUB-directory must not kill the walk — return
        // gracefully and let the parent keep iterating. EACCES on the
        // ROOT we asked about does surface, since the user requested
        // exactly that path.
        const namesResult = yield* Effect.tryPromise({
          try: () => readdir(dir),
          catch: (cause) => tryListError(cause, dir),
        }).pipe(
          Effect.either,
        )
        if (namesResult._tag === "Left") {
          // Sub-dir we can't enumerate (EACCES, NotADirectory, transient
          // errors) — skip and let the parent walk continue.
          if (!isRoot) return
          // Root: surface the error to the caller.
          return yield* Effect.fail(namesResult.left)
        }
        for (const name of namesResult.right) {
          if (name === ".git" || name === "node_modules") continue
          const full = join(dir, name)
          const stResult = yield* Effect.tryPromise({
            try: () => stat(full),
            catch: (cause) => tryListError(cause, full),
          }).pipe(Effect.either)
          if (stResult._tag === "Left") continue
          const st = stResult.right
          if (st.isDirectory()) {
            out.push({ path: full, type: "dir" })
            if (recursive) yield* walk(full, false)
          } else {
            out.push({ path: full, type: "file" })
          }
        }
      })
    yield* walk(path, true)
    return out
  })

interface BunGlob {
  scan: (opts: {
    cwd: string
    onlyFiles?: boolean
    dot?: boolean
  }) => AsyncIterable<string>
}

const collectGlob = async (
  pattern: string,
  root: string,
): Promise<string[]> => {
  const GlobCtor = (Bun as unknown as {
    Glob: new (p: string) => BunGlob
  }).Glob
  const glob = new GlobCtor(pattern)
  const matches: string[] = []
  // Use an explicit iterator so a single unreadable directory (e.g.
  // root-owned `pg-data/` from docker-compose, or anything with EACCES
  // on read) doesn't kill the whole scan. Without this, one
  // EACCES throws out of the for-await and the caller sees [].
  const iter = glob.scan({
    cwd: root,
    onlyFiles: false,
    dot: false,
  })[Symbol.asyncIterator]()
  while (true) {
    let next: IteratorResult<string>
    try {
      next = await iter.next()
    } catch (cause) {
      if (errCode(cause) === "EACCES" || errCode(cause) === "EPERM") continue
      throw cause
    }
    if (next.done) break
    const m = next.value
    if (m.split(sep).some((part) => part === "node_modules" || part === ".git"))
      continue
    matches.push(m)
  }
  return matches
}

const globMatches = (
  pattern: string,
  opts?: { cwd?: string; respectGitignore?: boolean },
) =>
  Effect.tryPromise({
    try: () => collectGlob(pattern, opts?.cwd ?? process.cwd()),
    catch: (cause) => fsError(cause, `glob '${pattern}'`),
  }).pipe(
    Effect.map((matches) =>
      matches.map((m) =>
        relative(process.cwd(), join(opts?.cwd ?? process.cwd(), m)),
      ),
    ),
  )

export const LocalFileSystemLive = Layer.succeed(FileSystem, {
  read: (path, opts) => readWithRange(path, opts),
  write: (path, content) => writeFileEffect(path, content),
  exists: (path) =>
    Effect.try({
      try: () => fs.existsSync(path),
      catch: (cause) => fsError(cause, `existsSync ${path}`),
    }),
  list: (path, opts) => walkDir(path, opts?.recursive === true),
  glob: (pattern, opts) => globMatches(pattern, opts),
})
