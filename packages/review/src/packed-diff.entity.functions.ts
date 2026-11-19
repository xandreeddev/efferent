import { Array as Arr, Order } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff } from "./diff.entity.functions.js"
import { DROPPED_BECAUSE } from "./file-verdict.entity.js"
import { DROPPED_SHOWN } from "./packed-diff.entity.js"
import type { DroppedFile, FileKind, PackedDiff } from "./packed-diff.entity.js"

const DOCS = /\.(md|mdx|markdown|rst|adoc|txt)$/i
const CONFIG = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|lock|env\.example)$/i

/** A path's kind: docs by extension, config by extension or a dotfile's name or a CI folder, code otherwise. */
export const fileKind = (path: string): FileKind => {
  const name = path.split("/").at(-1) ?? path
  if (DOCS.test(name)) return "docs"
  if (CONFIG.test(name) || name.startsWith(".") || path.startsWith(".github/")) return "config"
  return "code"
}

const KIND_ORDER: Readonly<Record<FileKind, number>> = { code: 0, docs: 1, config: 2 }

/** The order files are packed in: code before docs before config, then the most lines changed, then by path. */
const packingOrder: Order.Order<FileDiff> = Order.combineAll([
  Order.mapInput(Order.Number, (file: FileDiff) => KIND_ORDER[fileKind(file.path)]),
  Order.mapInput(Order.flip(Order.Number), (file: FileDiff) => file.additions + file.deletions),
  Order.mapInput(Order.String, (file: FileDiff) => file.path),
])

/** The line naming a file left out of the diff, with its counts and its reason in words. */
const droppedLine = (file: DroppedFile): string => `- ${file.path} (+${file.additions} -${file.deletions}): ${DROPPED_BECAUSE[file.reason]}`

/**
 * The lines for the files left out: the first `shown` one by one, then one line per reason for the rest, in the
 * order the reasons are first met among them, each with how many files and their lines added and removed.
 */
export const droppedLines = (dropped: ReadonlyArray<DroppedFile>, shown: number = DROPPED_SHOWN): ReadonlyArray<string> => {
  const rest = dropped.slice(shown)
  const reasons = [...new Set(rest.map((file) => file.reason))]
  return [
    ...dropped.slice(0, shown).map(droppedLine),
    ...reasons.map((reason) => {
      const files = rest.filter((file) => file.reason === reason)
      const sum = (pick: (file: DroppedFile) => number) => files.reduce((total, file) => total + pick(file), 0)
      return `- ${files.length} more ${files.length === 1 ? "file" : "files"} (+${sum((file) => file.additions)} -${sum((file) => file.deletions)}): ${DROPPED_BECAUSE[reason]}`
    }),
  ]
}

/**
 * Pack the files a verdict kept under a token budget: in `packingOrder`, each file whose rendered text fits in what
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
    ...(dropped.length > 0 ? [["Left out of this diff:", ...droppedLines(dropped)].join("\n")] : []),
  ]
  const text = sections.join("\n\n")
  return { text, tokens: estimateTokens(text), kept: kept.map((file) => file.path), dropped }
}
