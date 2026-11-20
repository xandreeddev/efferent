import { Array as Arr, Option, Order } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff, shownPath } from "./diff.entity.functions.js"
import { GroupNumber, REQUEST_SLACK_BYTES } from "./file-group.entity.js"
import type { CallPrice, FileGroup, GroupBounds, GroupOrder, UngroupedFile } from "./file-group.entity.js"
import { fileKind, isTestPath } from "./packed-diff.entity.functions.js"
import type { FileKind } from "./packed-diff.entity.js"
import type { ReviewPrompt } from "./review-prompt.entity.js"

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

/**
 * Whether a changed file gets a focused pass: code (`fileKind`), a test's, a page's and an `.astro` file (which holds
 * script) included; never config, a manifest or docs.
 */
export const isGrouped = (path: string): boolean => fileKind(path) === "code"

/** The note for a folder whose `package.json` could not be looked up: its files are grouped as if it held none. */
export const lookupFailedNote = (folder: string): string =>
  `The package.json of ${folder === "" ? "the root" : shownPath(folder)} could not be looked up, so its files were grouped as if it held none.`

/** The note for a check run on the prefix of a group whose pass never answered: no cache to read. */
export const uncachedCheckNote = (check: number, group: number): string =>
  `Check ${check} ran on the prefix of group ${group}, whose pass never answered, so it had no cache to read.`

/** Why a file a review reads gets no focused pass, in words, by its kind. */
const UNGROUPED_BECAUSE: Readonly<Record<Exclude<FileKind, "code">, string>> = {
  manifest: "a manifest or CI file",
  config: "config",
  docs: "docs",
}

/** The files a review reads that no group holds, each with why (`UNGROUPED_BECAUSE`), in the order given. */
export const ungroupedOf = (files: ReadonlyArray<FileDiff>, groups: ReadonlyArray<FileGroup>): ReadonlyArray<UngroupedFile> => {
  const grouped = new Set(groups.flatMap((group) => group.paths))
  return files.filter((file) => !grouped.has(file.path)).map((file) => {
    const kind = fileKind(file.path)
    return { path: file.path, why: kind === "code" ? "code no group holds" : UNGROUPED_BECAUSE[kind] }
  })
}

/**
 * What a group's first call is held at before it is sent, in USD: its prompt's bytes (the prefix's and the tail's text,
 * and `REQUEST_SLACK_BYTES` for the tools' declarations) as tokens at `bytesPerToken`, at the input price, and a full
 * answer (`maxOutputTokens`) at the output price.
 */
export const firstCallHold = (prompt: ReviewPrompt, price: CallPrice): number => {
  const encoder = new TextEncoder()
  const bytes = [...prompt.prefix.map((part) => part.content), prompt.tail].reduce((sum, text) => sum + encoder.encode(text).length, REQUEST_SLACK_BYTES)
  return (bytes / price.bytesPerToken) * (price.input / 1e6) + price.maxOutputTokens * (price.output / 1e6)
}

/** Words on an added line that mark shared state, concurrency, processes, files, the network or secrets: `RISKY_CASED` as written, `RISKY_ANY` in any case. */
const RISKY_CASED = /\b(Ref|Semaphore|Deferred|Queue|PubSub|Fiber)\b/
const RISKY_ANY = /\b(fork|scope|finali[sz]er|acquire|release|spawn|kill|exec|chmod|umask|fetch|token|secret|auth|lock|race|retry|timeout|stream|subscribe|signal|process|env|cache)|\bopen\(/i

/** How many lines a file adds that hold a risky word (`RISKY_CASED`, `RISKY_ANY`). */
const riskyLines = (file: FileDiff): number =>
  file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line._tag === "Added" && (RISKY_CASED.test(line.text) || RISKY_ANY.test(line.text))).length

/** How many lines a file adds. */
const addedLines = (file: FileDiff): number => file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line._tag === "Added").length

/**
 * A group's risk, from its files' diffs: 4 for each added line of a source file that holds a risky word, 1 for each
 * such line of a test, and a hundredth for each added source line (size breaks ties between groups with as many).
 */
export const riskOf = (files: ReadonlyArray<FileDiff>): number =>
  files.reduce((sum, file) => sum + (isTestPath(file.path) ? riskyLines(file) : 4 * riskyLines(file) + addedLines(file) / 100), 0)

/**
 * The groups in the order a focused review runs them, renumbered from 1: highest `riskOf` first, ties in the order
 * given (git's), with `risk`; as given with `git`.
 */
export const orderGroups = (groups: ReadonlyArray<FileGroup>, files: ReadonlyArray<FileDiff>, order: GroupOrder): ReadonlyArray<FileGroup> => {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const risk = new Map(groups.map((group) => [group, riskOf(group.paths.flatMap((path) => Option.toArray(Option.fromNullishOr(byPath.get(path)))))]))
  const ordered = order === "git" ? groups : Arr.sort(groups, Order.mapInput(Order.flip(Order.Number), (group: FileGroup) => risk.get(group) ?? 0))
  return ordered.map((group, index) => ({ ...group, number: GroupNumber.make(index + 1) }))
}

/** Files that stay together while they fit: those of one stem in one folder, a test in a test folder with its source's. */
interface Unit {
  readonly files: Array<FileDiff>
  readonly first: number
}

/**
 * The changed files grouped for focused passes (`groups` focus): the code files (`isGrouped`) in the order
 * given (git's), by package (`packageOf` over `roots`); a package whose files fit `bounds` is one group; a larger one is
 * cut into units (a stem's files in one folder, a test in a `test`, `tests`, `__tests__` or `spec` folder with the
 * source of its stem), filled in order into groups up to `bounds`, a unit too large for one cut into its files, a file
 * over the bounds a group alone. The groups with source come first, then those of tests alone, each in the order of its
 * first file; numbered from 1. With `config`, the other files a review reads but docs make one group more, last,
 * whatever its size.
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
  const rest = config ? files.filter((file) => !isGrouped(file.path) && fileKind(file.path) !== "docs") : []
  const all = [...ordered, ...(rest.length > 0 ? [{ package: ".", files: rest }] : [])]
  return all.map((group, index) => ({
    number: GroupNumber.make(index + 1),
    package: group.package,
    paths: group.files.map((file) => file.path),
    tokens: size(group.files),
  }))
}
