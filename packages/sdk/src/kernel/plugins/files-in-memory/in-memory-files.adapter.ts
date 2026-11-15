import { Array as Arr, Effect, Layer, Order, Ref, Result } from "effect"
import { FileChanged, FileNotFound } from "../../contracts/files/files.entity.js"
import type { Expected, FilePath } from "../../contracts/files/files.entity.js"
import { inFolder, workspacePath } from "../../contracts/files/files.entity.functions.js"
import { Files } from "../../contracts/files/files.port.js"

/** Whether a file that holds `held` (or none) is what a write expected. */
const meets = (held: string | undefined, expected: Expected): boolean =>
  expected._tag === "Absent" ? held === undefined : held === expected.text

/**
 * A workspace in memory (ADR 0017): `Files` over a map of paths to texts, gone when the layer's scope closes. Each
 * build is a workspace of its own. `initial` gives the files it starts with; a path in it that is not one in the
 * workspace is refused where it is written: it throws, as a definition does. A write is one step: the check of what
 * it expects and the write cannot be split by another.
 *
 * @public
 */
export const inMemoryFiles = (initial: Readonly<Record<string, string>> = {}): Layer.Layer<Files> => {
  const start = new Map(Object.entries(initial).map(([path, text]) => [
    Result.getOrThrowWith(workspacePath(path), (problem) => new Error(`inMemoryFiles: ${problem}`)),
    text,
  ] as const))
  return Layer.effect(Files, Effect.gen(function* () {
    const files = yield* Ref.make<ReadonlyMap<FilePath, string>>(start)
    return Files.of({
      read: (path) => Effect.flatMap(Ref.get(files), (held) => {
        const text = held.get(path)
        return text === undefined ? Effect.fail(new FileNotFound({ path, message: `no file is at ${path}` })) : Effect.succeed(text)
      }),
      list: (folder) => Effect.map(Ref.get(files), (held) => Arr.sort(Array.from(held.keys()).filter((path) => inFolder(path, folder)), Order.String)),
      write: (path, text, expected) => Effect.flatten(Ref.modify(files, (held): readonly [Effect.Effect<void, FileChanged>, ReadonlyMap<FilePath, string>] =>
        expected !== undefined && !meets(held.get(path), expected)
          ? [Effect.fail(new FileChanged({ path, message: `${path} does not hold what the write expected` })), held]
          : [Effect.void, new Map(held).set(path, text)],
      )),
    })
  }))
}
