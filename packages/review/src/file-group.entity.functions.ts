import { Array as Arr, Order } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff } from "./diff.entity.functions.js"
import { GroupNumber } from "./file-group.entity.js"
import type { FileGroup, GroupBounds } from "./file-group.entity.js"
import { fileKind, isPageOrDocs, isSourcePath, isTestPath } from "./packed-diff.entity.functions.js"

/** The folder a path sits in, `""` at the root. */
const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/")

/** Every folder a path sits under, the root (`""`) first, then each deeper one. */
const foldersAbove = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/").slice(0, -1)
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))]
}

/** The folders whose `package.json` decides the packages of `paths`: every folder any of them sits under, in code-unit order. */
export const packageFoldersToLook = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.sort(Arr.dedupe(paths.flatMap(foldersAbove)), Order.String)

/** A path's package: the deepest of `roots` (folders holding a `package.json`) it sits under, `.` for the root or none. */
export const packageOf = (path: string, roots: ReadonlySet<string>): string => {
  const deepest = [...foldersAbove(path)].reverse().find((folder) => roots.has(folder))
  return deepest === undefined || deepest === "" ? "." : deepest
}

/** A file's name up to its first dot: `charge.adapter.test.ts` is `charge`, so a port, its adapters and their tests share it. */
export const stemOf = (path: string): string => (path.split("/").at(-1) ?? path).split(".")[0] ?? ""

/** Whether a changed file gets a focused pass: source code or a test, never config, a manifest, a page or docs. */
export const isGrouped = (path: string): boolean => isSourcePath(path) || (fileKind(path) === "code" && isTestPath(path) && !isPageOrDocs(path))

/** Files that stay together while they fit: those of one stem in one folder, a test in a test folder with its source's. */
interface Unit {
  readonly files: Array<FileDiff>
  readonly first: number
}

/**
 * The changed files grouped for focused passes (`groups` focus): the source and test files (`isGrouped`) in the order
 * given (git's), by package (`packageOf` over `roots`); a package whose files fit `bounds` is one group; a larger one is
 * cut into units (a stem's files in one folder, a test in a `test`, `tests`, `__tests__` or `spec` folder with the
 * source of its stem), filled in order into groups up to `bounds`, a unit too large for one cut into its files, a file
 * over the bounds a group alone. The groups with source come first, then those of tests alone, each in the order of its
 * first file; numbered from 1. With `config`, the other files a review reads but pages and docs make one group more,
 * last, whatever its size.
 */
export const groupFiles = (files: ReadonlyArray<FileDiff>, roots: ReadonlySet<string>, bounds: GroupBounds, config = false): ReadonlyArray<FileGroup> => {
  const tokensOf = new Map(files.map((file) => [file, Number(estimateTokens(renderDiff([file])))]))
  const size = (group: ReadonlyArray<FileDiff>) => group.reduce((sum, file) => sum + (tokensOf.get(file) ?? 0), 0)
  const indexOf = new Map(files.map((file, index) => [file, index]))
  const grouped = files.filter((file) => isGrouped(file.path))
  const packages = Arr.dedupe(grouped.map((file) => packageOf(file.path, roots)))
  const made: Array<{ readonly package: string; readonly files: ReadonlyArray<FileDiff> }> = []
  for (const name of packages) {
    const own = grouped.filter((file) => packageOf(file.path, roots) === name)
    if (size(own) <= bounds.tokens && own.length <= bounds.files) {
      made.push({ package: name, files: own })
      continue
    }
    const units = new Map<string, Unit>()
    const keyOf = (file: FileDiff): string => {
      const inTestFolder = /(^|\/)(__tests__|tests?|spec)\//.test(file.path)
      if (inTestFolder) {
        const source = own.find((other) => !isTestPath(other.path) && stemOf(other.path) === stemOf(file.path))
        if (source !== undefined) return `${folderOf(source.path)}\u0000${stemOf(source.path)}`
      }
      return `${folderOf(file.path)}\u0000${stemOf(file.path)}`
    }
    for (const file of own) {
      const key = keyOf(file)
      const unit = units.get(key)
      if (unit === undefined) units.set(key, { files: [file], first: indexOf.get(file) ?? 0 })
      else unit.files.push(file)
    }
    const pieces = [...units.values()].flatMap((unit) => (size(unit.files) <= bounds.tokens && unit.files.length <= bounds.files ? [unit.files] : unit.files.map((file) => [file])))
    let current: Array<FileDiff> = []
    for (const piece of pieces) {
      if (current.length > 0 && (size(current) + size(piece) > bounds.tokens || current.length + piece.length > bounds.files)) {
        made.push({ package: name, files: current })
        current = []
      }
      current = [...current, ...piece]
    }
    if (current.length > 0) made.push({ package: name, files: current })
  }
  const hasSource = (group: { readonly files: ReadonlyArray<FileDiff> }) => group.files.some((file) => !isTestPath(file.path))
  const ordered = Arr.sort(made, Order.combine(
    Order.mapInput(Order.Number, (group: (typeof made)[number]) => (hasSource(group) ? 0 : 1)),
    Order.mapInput(Order.Number, (group: (typeof made)[number]) => Math.min(...group.files.map((file) => indexOf.get(file) ?? 0))),
  ))
  const rest = config ? files.filter((file) => !isGrouped(file.path) && !isPageOrDocs(file.path)) : []
  const all = [...ordered, ...(rest.length > 0 ? [{ package: ".", files: rest }] : [])]
  return all.map((group, index) => ({
    number: GroupNumber.make(index + 1),
    package: group.package,
    paths: group.files.map((file) => file.path),
    tokens: size(group.files),
  }))
}
