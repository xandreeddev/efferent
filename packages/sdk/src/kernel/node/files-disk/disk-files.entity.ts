/**
 * How `diskFiles` keeps a workspace in a folder (ADR 0028).
 *
 * - `root`: the folder, which must exist. No path of the workspace leaves it, through `..` (no `FilePath` holds one)
 *   or through a link (each path's real path is checked to be in the root's).
 * - `maxBytes`: the largest file it reads or writes, 1,048,576 bytes (1 MiB) by default. A larger file is declined
 *   (`FilesRefused`), and a search passes over it.
 * - `ignore`: the names a listing passes over, at any depth, and does not go into: `DEFAULT_IGNORE` (`.git`,
 *   `node_modules`) when left out. The host's list replaces it: give `[...DEFAULT_IGNORE, "dist"]` to add one. A path
 *   under an ignored name can still be read and written; what is ignored is only not listed (nor searched). A host
 *   that keeps a folder from the agent declines it in a `Files` of its own.
 *
 * @public
 */
export interface DiskFilesOptions {
  readonly root: string
  readonly maxBytes?: number
  readonly ignore?: ReadonlyArray<string>
}

/**
 * The names a disk workspace's listing passes over when its host names none: a repository's history and a package
 * manager's folder, which are large, are not the agent's to edit, and a search would read every file of.
 *
 * @public
 */
export const DEFAULT_IGNORE: ReadonlyArray<string> = [".git", "node_modules"]

/**
 * The largest file a disk workspace reads or writes when its host names no bound: 1 MiB, 262 pages of `readFile`.
 *
 * @public
 */
export const DEFAULT_MAX_BYTES = 1_048_576
