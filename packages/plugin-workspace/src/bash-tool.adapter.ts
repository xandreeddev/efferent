import { Tool } from "effect/ai"
import { Array as Arr, Clock, Effect, Option, Order, Random, Stream } from "effect"
import { Bash, CurrentToolInvocation, defineTool, Failure, publishToolProgress, RunContext } from "@xandreed/core"
import type { BashChunk, BashEvent, BashExit, BashOptions, RegisteredTool } from "@xandreed/core"
import { clipHead, tailText, utf8Length } from "./text-window.entity.functions.js"
import { openWorkspace } from "./workspace-path.entity.functions.js"
import type { WorkspaceAccess } from "./workspace-path.entity.functions.js"
import { BashParams, BashToolResult, WORKSPACE_PERMISSIONS } from "./workspace-tools.entity.js"
import { bashEnvironment, compactBash, renderBash, toolDescriptions } from "./workspace-tools.entity.functions.js"
import { failure } from "./read-tools.adapter.js"
import type { WorkspaceToolContext } from "./read-tools.adapter.js"

const BashTool = (description: string) => Tool.make("bash", { description, parameters: BashParams, success: BashToolResult, failure: Failure, failureMode: "return" })

/** The file a command's output is saved to: how many bytes of it are there, and whether some were left out to keep it within the cap. */
interface Spill {
  readonly file: string
  readonly bytes: number
  readonly cut: boolean
}

/**
 * A command's output while it runs: `tail`, the end of it (enough for the
 * tail the model is shown); `whole`, all of it while it is short enough to
 * keep (none once it was saved to `spill` or dropped); how many bytes, line
 * breaks and `\r\n` pairs came; whether the last line is still open; the
 * spill file once there is one; and the command's end once it came.
 */
interface Gathered {
  readonly tail: string
  readonly whole: Option.Option<string>
  readonly bytes: number
  readonly breaks: number
  readonly crlf: number
  readonly open: boolean
  readonly spill: Option.Option<Spill>
  readonly exit: Option.Option<BashExit>
}

const isChunk = (event: BashEvent): event is BashChunk => event._tag === "BashChunk"
const isExit = (event: BashEvent): event is BashExit => event._tag === "BashExit"

/** Chunks in a row from one stream, as one text each: what one `tool.progress` carries. */
const runsOf = (chunks: ReadonlyArray<BashChunk>): ReadonlyArray<{ readonly stream: BashChunk["stream"]; readonly text: string }> =>
  chunks.reduce<Array<{ readonly stream: BashChunk["stream"]; readonly text: string }>>((runs, chunk) => {
    const last = runs.at(-1)
    if (last !== undefined && last.stream === chunk.stream) runs.splice(-1, 1, { stream: chunk.stream, text: last.text + chunk.text })
    else runs.push({ stream: chunk.stream, text: chunk.text })
    return runs
  }, [])

/** Keep the newest `keep` spill files of the directory (they are named by time), removing the rest; best effort. */
const prune = (access: WorkspaceAccess, dir: string, keep: number): Effect.Effect<void> => access.fs.list(dir).pipe(
  Effect.map((entries) => Arr.sort(entries.filter((entry) => entry.kind === "file" && /^bash-.*\.log$/.test(entry.name)).map((entry) => entry.name), Order.String)),
  Effect.flatMap((names) => Effect.forEach(names.slice(0, Math.max(0, names.length - keep)), (name) => access.fs.remove(access.path.join(dir, name)), { concurrency: 1, discard: true })),
  Effect.ignore({ log: "Warn", message: `the older spill files in ${dir} were not pruned` }),
)

/**
 * `bash`: run a command in the workspace root through the `Bash` service of
 * the call. Output is published as it comes (`tool.progress`: gathered for
 * `progressMs`, then one event per run of output from one stream), and
 * folded into a tail the model is shown: the last `maxLines` lines within
 * `maxBytes`. Once the output is longer than that, it goes to a file under
 * `spillDir` (named by time and call), whose path the result gives, up to
 * `maxFileBytes` (what `read` opens; past that nothing more is saved, and
 * the result says `fullOutputCut`); the newest `spillKeep` files are kept.
 * A non-zero exit, a signal and a timeout are results; only a command that
 * could not run at all is a failure.
 */
export const bashTool = (context: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: BashTool(toolDescriptions(context.config).bash),
  handler: (params) => Effect.gen(function* () {
    const { config } = context
    const access = yield* openWorkspace(context.path)
    const bash = yield* Bash
    const run = yield* Effect.serviceOption(RunContext)
    const invocation = yield* Effect.service(CurrentToolInvocation)
    const timeoutMs = Math.min(params.timeout === undefined ? config.bashTimeoutMs : params.timeout * 1_000, config.bashMaxTimeoutMs)
    const options: BashOptions = {
      cwd: access.root,
      ...bashEnvironment(config, Option.map(run, (current) => ({ sessionId: String(current.session.id), runId: current.runId, workspace: access.root }))),
      timeoutMs,
      ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
    }
    const spillDir = Option.map(Option.fromNullishOr(config.spillDir), (dir) => access.path.join(access.root, dir))
    const started = yield* Clock.currentTimeMillis
    const tag = yield* Option.match(invocation, {
      onSome: (call) => Effect.succeed(call.invocationId.replace(/[^A-Za-z0-9._-]/g, "_")),
      onNone: () => Random.nextIntBetween(0, 2_147_483_647).pipe(Effect.map((value) => value.toString(36))),
    })
    const spillName = `bash-${String(started).padStart(15, "0")}-${tag}.log`

    /** The part of `text` that still fits in a spill file holding `bytes`, and whether some of it did not. */
    const fitting = (bytes: number, text: string) => {
      const piece = clipHead(text, Math.max(0, config.maxFileBytes - bytes))
      return { piece, bytes: bytes + utf8Length(piece), cut: piece.length < text.length }
    }

    /** Start the spill file with what came so far; none (and a warning) when it cannot be written. */
    const startSpill = (text: string): Effect.Effect<Option.Option<Spill>> => Option.match(spillDir, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (dir) => {
        const file = access.path.join(dir, spillName)
        const first = fitting(0, text)
        return access.fs.write(file, first.piece, { createParents: true }).pipe(
          Effect.andThen(prune(access, dir, config.spillKeep)),
          Effect.as(Option.some({ file, bytes: first.bytes, cut: first.cut })),
          Effect.catch((error) => Effect.logWarning(`bash: the command's whole output could not be saved to ${file}: ${error.message}`).pipe(Effect.as(Option.none<Spill>()))),
        )
      },
    })
    /** Add to the spill file what still fits; once something did not, nothing more is added. */
    const addToSpill = (spill: Spill, text: string): Effect.Effect<Spill> => {
      if (spill.cut || text.length === 0) return Effect.succeed(spill)
      const next = fitting(spill.bytes, text)
      return (next.piece.length === 0 ? Effect.void : access.fs.append(spill.file, next.piece).pipe(Effect.catch((error) =>
        Effect.logWarning(`bash: could not add to ${spill.file}: ${error.message}`)))).pipe(Effect.as({ ...spill, bytes: next.bytes, cut: next.cut }))
    }
    /**
     * Whether the tail can no longer show all of the output: more line
     * breaks than `maxLines`, or more bytes than `maxBytes` once what the
     * tail drops is taken off (a `\r` before each `\n`, and the last `\n`).
     * Never true while the whole output still fits; when it fits only
     * because of a last line left open, the end of the run saves it.
     */
    const over = (state: Pick<Gathered, "bytes" | "breaks" | "crlf">) => state.bytes - state.crlf - 1 > config.maxBytes || state.breaks > config.maxLines

    const step = (state: Gathered, group: ReadonlyArray<BashEvent>): Effect.Effect<Gathered> => Effect.gen(function* () {
      const chunks = group.filter(isChunk)
      yield* Effect.forEach(runsOf(chunks), (current) => publishToolProgress(current.stream, current.text), { concurrency: 1, discard: true })
      const text = chunks.map((chunk) => chunk.text).join("")
      const bytes = state.bytes + utf8Length(text)
      const breaks = state.breaks + (text.split("\n").length - 1)
      const crlf = state.crlf + (text.split("\r\n").length - 1) + (state.tail.endsWith("\r") && text.startsWith("\n") ? 1 : 0)
      const exit = Option.orElse(Option.fromNullishOr(group.find(isExit)), () => state.exit)
      const base = { tail: (state.tail + text).slice(-(config.maxBytes + 2)), bytes, breaks, crlf, open: text.length === 0 ? state.open : !text.endsWith("\n"), exit }
      if (Option.isSome(state.spill)) return { ...base, whole: Option.none(), spill: Option.some(yield* addToSpill(state.spill.value, text)) }
      const whole = Option.map(state.whole, (sofar) => sofar + text)
      if (!over(base) || Option.isNone(whole)) return { ...base, whole, spill: Option.none() }
      return { ...base, whole: Option.none(), spill: yield* startSpill(whole.value) }
    })

    const gathered = yield* bash.stream(params.command, options).pipe(
      Stream.groupedWithin(4_096, `${config.progressMs} millis`),
      Stream.runFoldEffect((): Gathered => ({ tail: "", whole: Option.some(""), bytes: 0, breaks: 0, crlf: 0, open: false, spill: Option.none(), exit: Option.none() }), step),
      Effect.mapError((error) => failure(error.reason, error.message)),
    )
    const shown = tailText(Option.getOrElse(gathered.whole, () => gathered.tail), config.maxLines, config.maxBytes)
    const truncated = Option.isNone(gathered.whole) || shown.truncated
    // Still whole, yet longer than the tail (a last line left open took it over): save it now.
    const spill = Option.isSome(gathered.spill) || !truncated ? gathered.spill
      : yield* Option.match(gathered.whole, { onNone: () => Effect.succeed(Option.none<Spill>()), onSome: startSpill })
    const ended = yield* Clock.currentTimeMillis
    return {
      command: params.command,
      output: shown.text,
      exitCode: Option.getOrNull(Option.flatMap(gathered.exit, (exit) => exit.exitCode)),
      signal: Option.getOrNull(Option.flatMap(gathered.exit, (exit) => exit.signal)),
      termination: Option.match(gathered.exit, { onNone: () => "interrupted" as const, onSome: (exit) => exit.termination }),
      truncated,
      totalLines: gathered.breaks + (gathered.open ? 1 : 0),
      fullOutput: Option.getOrNull(Option.map(spill, (saved) => access.path.relative(access.root, saved.file))),
      fullOutputCut: Option.exists(spill, (saved) => saved.cut),
      durationMs: Option.match(gathered.exit, { onNone: () => ended - started, onSome: (exit) => exit.durationMs }),
    }
  }),
  view: { version: "1", render: renderBash, compact: compactBash },
  annotations: { permissions: [WORKSPACE_PERMISSIONS.exec], pollable: true },
})
