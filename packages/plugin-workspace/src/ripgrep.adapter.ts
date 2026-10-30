import { Effect, Option, Stream } from "effect"
import { Bash, RunContext } from "@xandreed/core"
import type { BashEvent, BashExit, Failure } from "@xandreed/core"
import { rgReasonOf } from "./local-system.entity.functions.js"
import { decodeRgMessage, emptyRgSearch, foldRgMessage, rgLines, rgRecords, ripgrepCommand } from "./ripgrep.entity.functions.js"
import type { RgSearch } from "./ripgrep.entity.functions.js"
import { clipHead } from "./text-window.entity.functions.js"
import { displayOf, excludesBelow, isWithin } from "./workspace-path.entity.functions.js"
import type { WorkspaceAccess } from "./workspace-path.entity.functions.js"
import type { WorkspaceTarget } from "./workspace-path.entity.js"
import type { GrepParams, GrepResult, WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { bashEnvironment } from "./workspace-tools.entity.functions.js"

interface Output {
  readonly search: RgSearch
  readonly buffer: string
  readonly stderr: string
  readonly exit: Option.Option<BashExit>
  readonly invalid: boolean
}
const empty: Output = { search: emptyRgSearch, buffer: "", stderr: "", exit: Option.none(), invalid: false }
const failure = (error: string, message: string): Failure => ({ error, message })

/** A bounded, interruptible search on the same machine as the Bash/FileSystem pair. */
export const searchRipgrep = Effect.fn("workspace.grep")(function* (access: WorkspaceAccess, target: WorkspaceTarget, directory: boolean, params: GrepParams, config: WorkspaceToolsConfig) {
  const bash = yield* Bash
  const run = yield* Effect.serviceOption(RunContext)
  const cwd = directory ? target.path : access.path.dirname(target.path)
  const input = directory ? "." : access.path.basename(target.path)
  const exclude = excludesBelow(config.exclude, isWithin(access.root, cwd) ? Option.some(access.path.relative(access.root, cwd)) : Option.none())
  const limit = params.limit ?? config.grepMatches
  const perFile = directory ? Math.max(1, Math.ceil(limit / 4)) : limit
  const options = { limit, perFile, directory, lineChars: config.grepLineChars, display: (path: string) => displayOf(access, access.path.resolve(cwd, path)) }
  const fold = (state: Output, event: BashEvent): Output => {
    if (event._tag === "BashExit") return { ...state, exit: Option.some(event) }
    if (event.stream === "stderr") return { ...state, stderr: clipHead(state.stderr + event.text, 16_384) }
    // JSON escaping can expand every source byte sixfold. A broken peer cannot grow the tail forever.
    const complete = state.buffer + event.text
    if (complete.split("\n").some((line) => line.length > config.maxFileBytes * 6 + 65_536)) return { ...state, invalid: true }
    const parsed = rgRecords("", complete)
    return { ...state, buffer: parsed.buffer, search: parsed.records.reduce((search, message) => search.stopped ? search : foldRgMessage(search, message, options), state.search) }
  }
  const output = yield* bash.stream(ripgrepCommand(config, params, input, perFile, exclude), {
    cwd, stdin: params.pattern.length === 0 ? "\n" : params.pattern, timeoutMs: config.grepTimeoutMs,
    ...bashEnvironment(config, Option.map(run, (current) => ({ sessionId: String(current.session.id), runId: current.runId, workspace: access.root }))),
  }).pipe(
    Stream.mapAccum(() => empty, (state, event) => { const next = fold(state, event); return [next, [next]] }),
    Stream.takeUntil((state) => state.search.stopped || state.invalid),
    Stream.runFold(() => empty, (_previous, state) => state),
    Effect.mapError((error) => failure(error.reason, error.message)),
  )
  const search = Option.match(decodeRgMessage(output.buffer), {
    onNone: () => output.search,
    onSome: (message) => foldRgMessage(output.search, message, options),
  })
  if (output.invalid) return yield* Effect.fail(failure("SearchFailed", "The search output was too large to read; narrow the path or the pattern and search again"))
  const timedOut = Option.exists(output.exit, (exit) => exit.termination === "timeout")
  const unreadable = output.stderr.split("\n").flatMap((line) => {
    const found = /^rg: (.*): .*\(os error (\d+)\)$/.exec(line)
    return found === null ? [] : [{ path: options.display(found[1] ?? ""), reason: rgReasonOf(Number(found[2])) }]
  })
  const invalid = Option.exists(output.exit, (exit) => Option.contains(exit.exitCode, 2)) && search.messages === 0 && unreadable.length === 0
  if (invalid) return yield* Effect.fail(failure("InvalidPattern", `The search pattern or glob could not be parsed: ${output.stderr.trim()}. Pass literal: true to search for the pattern as text`))
  const failed = Option.exists(output.exit, (exit) => exit.termination === "signal" || (exit.termination === "exit" && !Option.exists(exit.exitCode, (code) => code === 0 || code === 1 || code === 2)))
  if (failed) return yield* Effect.fail(failure("SearchFailed", "The file search could not finish; try a narrower path or tell the user the search is unavailable"))
  return {
    pattern: params.pattern, path: target.display, lines: rgLines(search, params.context ?? 0),
    matches: [...search.counts.values()].reduce((sum, count) => sum + count, 0), files: search.counts.size,
    skipped: search.skipped, truncated: search.truncated, unreadable, timedOut,
  } satisfies GrepResult
})
