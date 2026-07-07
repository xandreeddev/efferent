import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { FileSystem, FsError } from "@xandreed/engine"

const tryFs = <A>(path: string, run: () => Promise<A>): Effect.Effect<A, FsError> =>
  Effect.tryPromise({
    try: run,
    catch: (e) => new FsError({ path, message: String(e) }),
  })

export const LocalFileSystemLive = Layer.succeed(FileSystem, {
  read: (path: string) => tryFs(path, () => readFile(path, "utf-8")),
  write: (path: string, content: string) =>
    tryFs(path, async () => {
      await writeFile(path, content, "utf-8")
    }),
  exists: (path: string) =>
    tryFs(path, () => stat(path)).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    ),
  list: (dir: string) => tryFs(dir, () => readdir(dir)),
  mkdir: (dir: string) =>
    tryFs(dir, async () => {
      await mkdir(dir, { recursive: true })
    }),
})
