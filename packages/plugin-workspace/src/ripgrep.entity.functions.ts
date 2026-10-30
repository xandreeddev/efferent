import { Option, Schema } from "effect"
import { RgMessage } from "./ripgrep.entity.js"
import type { RgText } from "./ripgrep.entity.js"
import type { GrepLine, GrepParams, WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { clipChars } from "./text-window.entity.functions.js"

/** One literal POSIX shell argument, including quotes, newlines and metacharacters. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** The pattern goes only to stdin, never into the shell command. */
export const ripgrepCommand = (config: WorkspaceToolsConfig, params: GrepParams, target: string, perFile: number, exclude: ReadonlyArray<string>): string => [
  "rg", "--json", "--no-config", "--sort", "path", "--hidden", "--no-follow",
  ...(config.grepIgnoreFiles ? [] : ["--no-ignore"]),
  "--max-filesize", String(config.maxFileBytes),
  // One extra matching line proves a cap really hid a match. Context may add more.
  "--max-count", String(perFile + 1),
  ...(params.context === undefined ? [] : ["-C", String(params.context)]),
  ...(params.ignoreCase ? ["-i"] : []), ...(params.literal ? ["-F"] : []),
  "-f", "-",
  ...(params.glob === undefined ? [] : [`--glob=${params.glob}`]),
  ...exclude.map((glob) => `--glob=!${glob.replace(/^\.\//, "/")}`),
  "--", target,
].map(shellQuote).join(" ")

export const rgText = (value: RgText): string => "text" in value ? value.text : value.bytes
export const decodeRgMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RgMessage))

export interface RgSearch {
  readonly lines: ReadonlyArray<GrepLine>
  readonly counts: ReadonlyMap<string, number>
  readonly skipped: number
  readonly truncated: boolean
  readonly stopAtEnd: boolean
  readonly capped: ReadonlySet<string>
  readonly stopped: boolean
  readonly messages: number
}
export const emptyRgSearch: RgSearch = { lines: [], counts: new Map(), skipped: 0, truncated: false, stopped: false, stopAtEnd: false, capped: new Set(), messages: 0 }

/** Bound kept matches independently of rg's per-file cap (context can exceed it). */
export const foldRgMessage = (state: RgSearch, message: RgMessage, options: {
  readonly limit: number; readonly perFile: number; readonly lineChars: number; readonly directory?: boolean
  readonly display: (path: string) => string
}): RgSearch => {
  const next = { ...state, messages: state.messages + 1 }
  const add = (data: { readonly path: RgText; readonly lines: RgText; readonly line_number: number }, match: boolean): RgSearch => {
    const path = options.display(rgText(data.path))
    const count = state.counts.get(path) ?? 0
    const total = [...state.counts.values()].reduce((sum, found) => sum + found, 0)
    const text = rgText(data.lines).replace(/\r?\n$/, "")
    const row = { path, line: data.line_number, text: clipChars(text, options.lineChars).text, match }
    if (match && total >= options.limit) return { ...next, lines: [...state.lines, { ...row, match: false }], truncated: true, stopAtEnd: true, capped: new Set([...state.capped, path]) }
    if (match && count >= options.perFile) return { ...next, lines: [...state.lines, { ...row, match: false }], truncated: true, capped: new Set([...state.capped, path]) }
    return {
      ...next,
      lines: [...state.lines, row],
      counts: match ? new Map([...state.counts, [path, count + 1]]) : state.counts,
    }
  }
  return RgMessage.match(message, {
    begin: () => next,
    match: ({ data }) => add(data, true),
    context: ({ data }) => add(data, false),
    end: ({ data }) => {
      if (data.binary_offset === null) {
        const atLimit = [...state.counts.values()].reduce((sum, count) => sum + count, 0) >= options.limit
        return { ...next, stopped: state.stopAtEnd || atLimit, truncated: state.truncated || (options.directory === true && atLimit) }
      }
      const path = options.display(rgText(data.path))
      return { ...next, lines: state.lines.filter((line) => line.path !== path), counts: new Map([...state.counts].filter(([name]) => name !== path)), skipped: state.skipped + 1, stopped: false, stopAtEnd: false, capped: new Set([...state.capped].filter((name) => name !== path)), truncated: [...state.capped].some((name) => name !== path) }
    },
    summary: () => next,
  })
}

/** Keep only context surrounding selected matches; rg may send context for capped hits. */
export const rgLines = (state: RgSearch, context: number): ReadonlyArray<GrepLine> => {
  const shown = new Set(state.lines.filter((line) => line.match).flatMap((hit) =>
    Array.from({ length: context * 2 + 1 }, (_, offset) => `${hit.path}\0${hit.line - context + offset}`)))
  return state.lines.filter((line) => shown.has(`${line.path}\0${line.line}`))
}

/** Carry a partial JSON line between Bash chunks; decode only complete records. */
export const rgRecords = (buffer: string, chunk: string): { readonly buffer: string; readonly records: ReadonlyArray<RgMessage> } => {
  const lines = (buffer + chunk).split("\n")
  return { buffer: lines.at(-1) ?? "", records: lines.slice(0, -1).flatMap((line) => Option.toArray(decodeRgMessage(line))) }
}
