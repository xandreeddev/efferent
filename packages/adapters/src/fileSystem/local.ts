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
} from "@agent/core"

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
    ): Effect.Effect<
      void,
      FileNotFound | NotADirectory | FileSystemError
    > =>
      Effect.gen(function* () {
        const names = yield* Effect.tryPromise({
          try: () => readdir(dir),
          catch: (cause) => tryListError(cause, dir),
        })
        for (const name of names) {
          if (name === ".git" || name === "node_modules") continue
          const full = join(dir, name)
          const st = yield* Effect.tryPromise({
            try: () => stat(full),
            catch: (cause) => tryListError(cause, full),
          })
          if (st.isDirectory()) {
            out.push({ path: full, type: "dir" })
            if (recursive) yield* walk(full)
          } else {
            out.push({ path: full, type: "file" })
          }
        }
      })
    yield* walk(path)
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
  for await (const m of glob.scan({ cwd: root, onlyFiles: false, dot: false })) {
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
