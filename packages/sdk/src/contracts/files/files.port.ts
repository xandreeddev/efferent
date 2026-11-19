import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Expected, FileChanged, FileNotFound, FilePath, FilesRefused, FilesUnavailable } from "./files.entity.js"

/**
 * The workspace (ADR 0017): the files an agent acts on, which the host provides: a page's in memory or in its
 * storage, a test's in memory, a command line's on a disk. The kernel ships one in memory (`inMemoryFiles`), and one
 * in a folder of the disk on its Node entry (`diskFiles`, ADR 0028).
 *
 * - `read(path)`: the file's text.
 * - `list(folder)`: every file in the folder and the folders in it, or in the whole workspace for none, ordered by
 *   code unit. A folder is a path followed by `/`: `notes` lists `notes/a` and `notes/b/c`, never `notesx`.
 * - `write(path, text, expected?)`: create the file or replace its text. Given `expected`, the write is one step that
 *   first checks the file holds it, and fails with `FileChanged`, writing nothing, when it does not.
 *
 * A `Files` may decline a read or a write by a rule of its own (`FilesRefused`); it is the host's: the kernel's tools
 * never ask anyone. Only a tool's handler holds it among the agent's parts: no memory, fold or session plugin does,
 * so the agent's state and its prompts never depend on a file.
 *
 * @public
 */
export class Files extends Context.Service<Files, {
  readonly read: (path: FilePath) => Effect.Effect<string, FileNotFound | FilesRefused | FilesUnavailable>
  readonly list: (folder: Option.Option<FilePath>) => Effect.Effect<ReadonlyArray<FilePath>, FilesUnavailable>
  readonly write: (path: FilePath, text: string, expected?: Expected) => Effect.Effect<void, FileChanged | FilesRefused | FilesUnavailable>
}>()("@xandreed/sdk/kernel/Files") {}
