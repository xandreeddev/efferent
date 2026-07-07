/**
 * `bun run math` — the standalone math-practice product (docs/agents/
 * education.md), on the smith pattern: sdk-core + sdk-adapters composed at
 * this edge, never the cli. Serves the math shell on 127.0.0.1 and runs the
 * tutor agent over one persisted conversation (`~/.efferent/efferent.db`,
 * same store the CLI browses via `:browse`).
 *
 *   bun run math [--cwd <dir>] [--port <n>] [--open] [--grade <n>]
 *                [--theme "<topic>"] [--resume <conversationId>]
 */
import { homedir } from "node:os"
import { resolve } from "node:path"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Logger, Option } from "effect"
import { SettingsStore } from "@xandreed/sdk-core"
import {
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  ModelRegistryLive,
  StoresLive,
  UtilityLlmLive,
} from "@xandreed/sdk-adapters"
import { runMathMode } from "./mode.js"

interface ParseState {
  readonly cwd: string
  readonly port: Option.Option<number>
  readonly open: boolean
  readonly grade: Option.Option<number>
  readonly theme: Option.Option<string>
  readonly resume: Option.Option<string>
  readonly help: boolean
  readonly errors: ReadonlyArray<string>
  readonly pending: Option.Option<string>
}

const initial: ParseState = {
  cwd: process.cwd(),
  port: Option.none(),
  open: false,
  grade: Option.none(),
  theme: Option.none(),
  resume: Option.none(),
  help: false,
  errors: [],
  pending: Option.none(),
}

const VALUE_FLAGS = new Set(["--cwd", "--port", "--grade", "--theme", "--resume"])

const applyValue = (state: ParseState, flag: string, value: string): ParseState => {
  switch (flag) {
    case "--cwd":
      return { ...state, cwd: resolve(value) }
    case "--port":
      return /^\d+$/.test(value)
        ? { ...state, port: Option.some(Number(value)) }
        : { ...state, errors: [...state.errors, `--port expects a number (got ${value})`] }
    case "--grade":
      return /^\d+$/.test(value)
        ? { ...state, grade: Option.some(Number(value)) }
        : { ...state, errors: [...state.errors, `--grade expects a number (got ${value})`] }
    case "--theme":
      return { ...state, theme: Option.some(value) }
    case "--resume":
      return { ...state, resume: Option.some(value) }
    default:
      return { ...state, errors: [...state.errors, `unknown flag ${flag}`] }
  }
}

export const parseArgs = (argv: ReadonlyArray<string>): ParseState => {
  const folded = argv.reduce<ParseState>((state, arg) => {
    if (Option.isSome(state.pending)) {
      return { ...applyValue(state, state.pending.value, arg), pending: Option.none() }
    }
    if (arg === "--help" || arg === "-h") return { ...state, help: true }
    if (arg === "--open") return { ...state, open: true }
    if (VALUE_FLAGS.has(arg)) return { ...state, pending: Option.some(arg) }
    return { ...state, errors: [...state.errors, `unexpected argument ${arg}`] }
  }, initial)
  return Option.isSome(folded.pending)
    ? {
        ...folded,
        errors: [...folded.errors, `flag ${Option.getOrThrow(folded.pending)} expects a value`],
      }
    : folded
}

const USAGE = `usage: bun run math [--cwd <dir>] [--port <n>] [--open] [--grade <n>] [--theme "<topic>"] [--resume <conversationId>]`

/** The full service stack one math session runs on. */
export const mathAppLive = Layer.mergeAll(
  StoresLive,
  ModelLive,
  LocalFileSystemLive,
  LocalShellLive,
  UtilityLlmLive.pipe(Layer.provide(ModelRegistryLive), Layer.provide(FetchHttpClient.layer)),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive,
      LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
    ),
  ),
)

const isDirectRun = process.argv[1]?.endsWith("main.ts") === true
if (isDirectRun) {
  const state = parseArgs(process.argv.slice(2))
  if (state.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (state.errors.length > 0) {
    state.errors.forEach((error) => console.error(`math: ${error}`))
    console.error(USAGE)
    process.exit(2)
  }
  // Bun auto-loads the LAUNCH dir's .env; the efferent repo's own EFFERENT_MODEL
  // seed would silently override the user's configured model (the smith lesson).
  const envModel = process.env["EFFERENT_MODEL"]
  if (envModel !== undefined) {
    console.error(`math: ignoring EFFERENT_MODEL=${envModel} — configure .efferent/config.json`)
    delete process.env["EFFERENT_MODEL"]
  }

  const program = Effect.gen(function* () {
    const settings = yield* SettingsStore
    const resolved = yield* settings.load(state.cwd, homedir())
    process.stderr.write(`math: tutor on ${resolved.model}\n`)
    yield* runMathMode({
      workspace: state.cwd,
      version: "0.1.0",
      ...(Option.isSome(state.port) ? { port: state.port.value } : {}),
      ...(Option.isSome(state.resume) ? { resumeConversationId: state.resume.value } : {}),
      ...(state.open ? { open: true } : {}),
      ...(Option.isSome(state.grade) ? { grade: state.grade.value } : {}),
      ...(Option.isSome(state.theme) ? { theme: state.theme.value } : {}),
    })
  }).pipe(
    Effect.provide(mathAppLive),
    Effect.provide(BunContext.layer),
    // Server logs to stderr; the shell is the product surface.
    Effect.provide(Logger.replace(Logger.defaultLogger, Logger.prettyLogger({ stderr: true }))),
  )

  BunRuntime.runMain(program)
}
