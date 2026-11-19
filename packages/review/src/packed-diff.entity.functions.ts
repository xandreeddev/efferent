import { Array as Arr, Order } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff, shownPath } from "./diff.entity.functions.js"
import { DROPPED_BECAUSE, LOCKFILE_MANIFESTS } from "./file-verdict.entity.js"
import { nameOf } from "./file-verdict.entity.functions.js"
import { DROPPED_SHOWN, SMALL_CONFIG_LINES } from "./packed-diff.entity.js"
import type { DroppedFile, FileKind, PackedDiff } from "./packed-diff.entity.js"

const DOCS = /\.(md|mdx|markdown|rst|adoc|txt)$/i
const CONFIG = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|lock|env\.example)$/i

const MANIFESTS: ReadonlySet<string> = new Set(Object.values(LOCKFILE_MANIFESTS).flat())

/**
 * A path's kind: a manifest by name (a lockfile's manifests, `tsconfig*.json`) or under `.github/workflows/`; docs and
 * config by extension (config also a dotfile or under `.github/`); code otherwise.
 */
export const fileKind = (path: string): FileKind => {
  const name = nameOf(path)
  if (MANIFESTS.has(name) || /^tsconfig.*\.json$/.test(name) || path.startsWith(".github/workflows/")) return "manifest"
  if (DOCS.test(name)) return "docs"
  if (CONFIG.test(name) || name.startsWith(".") || path.startsWith(".github/")) return "config"
  return "code"
}

/** Where a file is packed: manifests and small config first, then code, then large config, then docs. */
const rankOf = (file: FileDiff): number => {
  const kind = fileKind(file.path)
  if (kind === "manifest" || (kind === "config" && file.additions + file.deletions <= SMALL_CONFIG_LINES)) return 0
  return { manifest: 0, config: 2, code: 1, docs: 3 }[kind]
}

/**
 * The order files are packed in: by `rankOf`; the first rank smallest first (many small manifests before one big
 * one), the others largest first; then by path in code-unit order.
 */
const packingOrder: Order.Order<FileDiff> = Order.combineAll([
  Order.mapInput(Order.Number, rankOf),
  Order.mapInput(Order.Number, (file: FileDiff) => (rankOf(file) === 0 ? 1 : -1) * (file.additions + file.deletions)),
  Order.mapInput(Order.String, (file: FileDiff) => file.path),
])

/** The line naming a file left out of the diff, with its counts and its reason in words. */
const droppedLine = (file: DroppedFile): string => `- ${shownPath(file.path)} (+${file.additions} -${file.deletions}): ${DROPPED_BECAUSE[file.reason]}`

/** The most manifests a lockfile's line names; the rest are counted. */
const MANIFESTS_NAMED = 3

/**
 * A lockfile's line: `- <path> changed (+A -D); <manifests> changed too`, the changed paths named as one of its
 * manifests (`LOCKFILE_MANIFESTS`) in the order given, at most three and the rest counted, or `; no manifest changed`.
 */
const lockfileLine = (file: DroppedFile, changedPaths: ReadonlyArray<string>): string => {
  const manifests = changedPaths.filter((path) => (LOCKFILE_MANIFESTS[nameOf(file.path)] ?? []).includes(nameOf(path)))
  const named = manifests.slice(0, MANIFESTS_NAMED).map(shownPath).join(", ")
  const more = manifests.length > MANIFESTS_NAMED ? ` and ${manifests.length - MANIFESTS_NAMED} more` : ""
  return `- ${shownPath(file.path)} changed (+${file.additions} -${file.deletions}); ${manifests.length === 0 ? "no manifest changed" : `${named}${more} changed too`}`
}

/**
 * The lines for the files left out: each lockfile's line (`lockfileLine`, never cut), then the others, the first
 * `shown` one by one and the rest one line per reason, in the order the reasons are first met among them, each with
 * how many files and their lines added and removed.
 */
export const droppedLines = (dropped: ReadonlyArray<DroppedFile>, changedPaths: ReadonlyArray<string>, shown: number = DROPPED_SHOWN): ReadonlyArray<string> => {
  const others = dropped.filter((file) => file.reason !== "lockfile")
  const rest = others.slice(shown)
  const reasons = [...new Set(rest.map((file) => file.reason))]
  return [
    ...dropped.filter((file) => file.reason === "lockfile").map((file) => lockfileLine(file, changedPaths)),
    ...others.slice(0, shown).map(droppedLine),
    ...reasons.map((reason) => {
      const files = rest.filter((file) => file.reason === reason)
      const sum = (pick: (file: DroppedFile) => number) => files.reduce((total, file) => total + pick(file), 0)
      return `- ${files.length} more ${files.length === 1 ? "file" : "files"} (+${sum((file) => file.additions)} -${sum((file) => file.deletions)}): ${DROPPED_BECAUSE[reason]}`
    }),
  ]
}

/**
 * Pack the files a verdict kept under a token budget: in `packingOrder` (manifests and CI files first), each file whose rendered text fits in what
 * the budget has left is kept, and one that does not is left out as `over-budget` (a smaller file after it may still
 * fit). The text is the kept files rendered (`renderDiff`), in that order, then `Left out of this diff:` and the
 * files left out (`droppedLines`): first those dropped before packing (`earlier`, in the order given), then those over
 * the budget, the first `DROPPED_SHOWN` by name and the rest counted by reason. The budget bounds the kept files'
 * text; `tokens` estimates the whole text.
 */
export const packDiff = (files: ReadonlyArray<FileDiff>, budgetTokens: number, earlier: ReadonlyArray<DroppedFile> = []): PackedDiff => {
  const kept: Array<FileDiff> = []
  const over: Array<DroppedFile> = []
  let left = budgetTokens
  for (const file of Arr.sort(files, packingOrder)) {
    // Each kept file after the first is separated from the one before by a blank line.
    const cost = estimateTokens(`${kept.length > 0 ? "\n\n" : ""}${renderDiff([file])}`)
    if (cost <= left) {
      kept.push(file)
      left -= cost
    } else over.push({ path: file.path, reason: "over-budget", additions: file.additions, deletions: file.deletions })
  }
  const dropped = [...earlier, ...over]
  const sections = [
    ...(kept.length > 0 ? [renderDiff(kept)] : []),
    ...(dropped.length > 0 ? [["Left out of this diff:", ...droppedLines(dropped, [...files.map((file) => file.path), ...earlier.map((file) => file.path)])].join("\n")] : []),
  ]
  const text = sections.join("\n\n")
  return { text, tokens: estimateTokens(text), kept: kept.map((file) => file.path), dropped }
}
