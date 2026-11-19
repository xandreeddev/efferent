import { Option, Schema } from "effect"
import { BlobSha } from "./checkout.entity.js"
import type { GrepHit, Transport, TreeEntry } from "./checkout.entity.js"

/**
 * A host-side git command's argv: no hook runs (`core.hooksPath=/dev/null`), no file-system monitor starts, no
 * transport but `transports` is allowed (`protocol.allow=never`, then each one `always`), and every path is literal
 * (`--literal-pathspecs`: a folder named `:(glob)x` or `:!x` is a name, never pathspec magic). `gitDir` is the
 * repository the command runs in (`-C`), none for a clone.
 */
export const gitArgv = (transports: ReadonlyArray<Transport>, gitDir: string | null, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "git",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never",
  ...transports.flatMap((transport) => ["-c", `protocol.${transport}.allow=always`]),
  "--literal-pathspecs",
  ...(gitDir === null ? [] : ["-C", gitDir]),
  ...args,
]

/** A regular file's modes in a tree: the only entries a tool reads. */
export const REGULAR: ReadonlyArray<string> = ["100644", "100755"]

/** One `ls-tree -z` entry: its mode, type and object, then its path after a tab. */
export const LS_ENTRY = /^(\d+) (\w+) ([0-9a-f]+)\t/

/** One `ls-tree -l -z` entry: its mode, type and object, its size (`-` for no blob) padded with spaces, then its path after a tab. */
export const LS_SIZED_ENTRY = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t/

/** What a listed entry is, by its mode and type; a regular file with its blob and its size in bytes. */
export const entryOf = (mode: string, type: string, object: string, bytes: number): TreeEntry => {
  if (type === "tree") return { _tag: "Folder" }
  if (type === "commit") return { _tag: "Submodule" }
  if (mode === "120000") return { _tag: "Link" }
  const blob = Schema.decodeUnknownOption(BlobSha)(object)
  return REGULAR.includes(mode) && Option.isSome(blob) && Number.isInteger(bytes) && bytes >= 0 ? { _tag: "File", blob: blob.value, bytes } : { _tag: "Missing" }
}

/**
 * The lines of `git grep -z -n` at a commit: each `<commit>:<path>` NUL `<line>` NUL `<text>` and a line feed, read in
 * order, so a path that holds a line feed is read whole.
 */
export const grepHitsOf = (output: string, at: string): ReadonlyArray<GrepHit> => {
  const hits: Array<GrepHit> = []
  const prefix = `${at}:`
  let from = 0
  while (from < output.length) {
    if (!output.startsWith(prefix, from)) break
    const pathEnd = output.indexOf("\0", from)
    const lineEnd = pathEnd < 0 ? -1 : output.indexOf("\0", pathEnd + 1)
    if (lineEnd < 0) break
    const textEnd = output.indexOf("\n", lineEnd + 1)
    const end = textEnd < 0 ? output.length : textEnd
    const line = Number(output.slice(pathEnd + 1, lineEnd))
    if (Number.isInteger(line) && line >= 1) hits.push({ path: output.slice(from + prefix.length, pathEnd), line, text: output.slice(lineEnd + 1, end) })
    from = end + 1
  }
  return hits
}
