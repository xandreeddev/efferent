// The smith driver edge: argv → SmithRunConfig → composition root → run.
// Mirrors the efferent CLI's AppLive (same adapters, same ~/.efferent auth +
// config.json tiers, same SQLite conversation store) minus the TUI-cli extras,
// with the smith settings overlay on top and a headless-safe Approval.

import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Effect, Layer, Logger, Option } from "effect"
import { BunContext } from "@effect/platform-bun"
import { SettingsStore } from "@xandreed/engine"
import {
  LanguageModelLive,
  UtilityLlmLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalShellLive,
  SqliteConversationStoreLive,
} from "@xandreed/providers"
import { ConfigError } from "@xandreed/foundry"
import { SMITH_LIMIT_DEFAULTS } from "./domain/SmithConfig.js"
import type { SmithRunConfig } from "./domain/SmithConfig.js"
import { SmithSettingsStoreLive } from "./settings/smithSettings.js"
import { runHeadless } from "./headless/print.js"
import { runHeadlessRefine } from "./refine/headless.js"
import { loadSpecDoc, mintUniqueSlug, writeSpecDoc } from "./spec/store.js"
import { trivialSpecDoc } from "./spec/toForgeSpec.js"

const USAGE = `smith — the spec-driven agent in the factory (foundry forge + the efferent coder)

Usage:
  bun run smith [--cwd <dir>]                 the persistent workspace session (TTY only)
  bun run smith spec "<rough idea>" [flags]   refine a SpecDoc (-p: one unattended draft; --yes locks)
  bun run smith forge <slug|spec.md> [flags]  forge a LOCKED spec
  bun run smith "<task>" [flags]              shorthand: trivial locked spec + forge

Flags:
  --cwd <dir>            workspace to forge IN PLACE (default: process.cwd())
  --accept "<criterion>" acceptance criterion (repeatable; shorthand path)
  --max-attempts <n>     forge attempts, 1..10 (default ${SMITH_LIMIT_DEFAULTS.maxAttempts})
  --budget <mins>        wall-clock budget in minutes (default ${SMITH_LIMIT_DEFAULTS.budgetMillis / 60_000})
  --model <p:m>          general role override (default opencode:kimi-k2.6, thinking high)
  --code-model <p:m>     code role override    (default opencode:kimi-k2.7-code)
  --fast-model <p:m>     fast role override    (default opencode:deepseek-v4-flash)
  --allow-bash           let the implementor run Bash (headless allow-all)
  --config <f>           explicit foundry GateSuiteConfig module for the gate suite
  --test-cmd "<cmd>"     test gate command (bash -c; default: bun test when package.json exists)
  --no-test              suppress the test gate
  --yes                  lock the refined draft without review (spec -p mode)
  -p, --headless         print mode (no TUI)
  -h, --help             this help

Specs live at <cwd>/.efferent/specs/<slug>.md (git-committable provenance).
Config: same conventions as the efferent CLI — ~/.efferent/auth.json (:login
there), .efferent/config.json local-over-global; smith defaults sit UNDER your
config. Exit: 0 accepted/locked · 1 rejected · 2 error.`

interface ParseState {
  readonly command: Option.Option<"spec" | "forge">
  readonly yes: boolean
  readonly task: Option.Option<string>
  readonly cwd: string
  readonly acceptance: ReadonlyArray<string>
  readonly maxAttempts: number
  readonly budgetMillis: number
  readonly general: Option.Option<string>
  readonly code: Option.Option<string>
  readonly fast: Option.Option<string>
  readonly allowBash: boolean
  readonly headless: boolean
  readonly testCommand: Option.Option<string>
  readonly noTest: boolean
  readonly configPath: Option.Option<string>
  readonly help: boolean
  readonly pending: Option.Option<string>
  readonly errors: ReadonlyArray<string>
}

const initialState: ParseState = {
  command: Option.none(),
  yes: false,
  task: Option.none(),
  cwd: process.cwd(),
  acceptance: [],
  maxAttempts: SMITH_LIMIT_DEFAULTS.maxAttempts,
  budgetMillis: SMITH_LIMIT_DEFAULTS.budgetMillis,
  general: Option.none(),
  code: Option.none(),
  fast: Option.none(),
  allowBash: false,
  headless: false,
  testCommand: Option.none(),
  noTest: false,
  configPath: Option.none(),
  help: false,
  pending: Option.none(),
  errors: [],
}

const BOOLEAN_FLAGS: Record<string, (state: ParseState) => ParseState> = {
  "--allow-bash": (s) => ({ ...s, allowBash: true }),
  "--headless": (s) => ({ ...s, headless: true }),
  "-p": (s) => ({ ...s, headless: true }),
  "--no-test": (s) => ({ ...s, noTest: true }),
  "--yes": (s) => ({ ...s, yes: true }),
  "--help": (s) => ({ ...s, help: true }),
  "-h": (s) => ({ ...s, help: true }),
}

const VALUE_FLAGS: Record<string, (state: ParseState, value: string) => ParseState> = {
  "--cwd": (s, v) => ({ ...s, cwd: isAbsolute(v) ? v : resolve(process.cwd(), v) }),
  "--accept": (s, v) => ({ ...s, acceptance: [...s.acceptance, v] }),
  "--max-attempts": (s, v) => ({ ...s, maxAttempts: Number(v) }),
  "--budget": (s, v) => ({ ...s, budgetMillis: Number(v) * 60_000 }),
  "--model": (s, v) => ({ ...s, general: Option.some(v) }),
  "--code-model": (s, v) => ({ ...s, code: Option.some(v) }),
  "--fast-model": (s, v) => ({ ...s, fast: Option.some(v) }),
  "--test-cmd": (s, v) => ({ ...s, testCommand: Option.some(v) }),
  "--config": (s, v) => ({ ...s, configPath: Option.some(isAbsolute(v) ? v : resolve(process.cwd(), v)) }),
}

export const parseArgs = (argv: ReadonlyArray<string>): ParseState => {
  const folded = argv.reduce((state, token) => {
    const pendingFlag = Option.getOrUndefined(state.pending)
    if (pendingFlag !== undefined) {
      const setter = VALUE_FLAGS[pendingFlag]
      return setter === undefined
        ? { ...state, pending: Option.none<string>() }
        : setter({ ...state, pending: Option.none<string>() }, token)
    }
    const boolSetter = BOOLEAN_FLAGS[token]
    if (boolSetter !== undefined) return boolSetter(state)
    if (VALUE_FLAGS[token] !== undefined) return { ...state, pending: Option.some(token) }
    if (token.startsWith("-")) {
      return { ...state, errors: [...state.errors, `unknown flag: ${token}`] }
    }
    // Reserved first tokens route the command; the next positional is its arg.
    if (Option.isNone(state.command) && Option.isNone(state.task)) {
      if (token === "spec") return { ...state, command: Option.some("spec" as const) }
      if (token === "forge") return { ...state, command: Option.some("forge" as const) }
    }
    return Option.isNone(state.task)
      ? { ...state, task: Option.some(token) }
      : { ...state, errors: [...state.errors, `unexpected argument: ${token}`] }
  }, initialState)
  return Option.isSome(folded.pending)
    ? {
        ...folded,
        errors: [...folded.errors, `flag ${Option.getOrThrow(folded.pending)} expects a value`],
      }
    : folded
}

export const toRunConfig = (state: ParseState, task: string): SmithRunConfig => ({
  task,
  cwd: state.cwd,
  acceptance: state.acceptance,
  maxAttempts: state.maxAttempts,
  budgetMillis: state.budgetMillis,
  models: { general: state.general, code: state.code, fast: state.fast },
  allowBash: state.allowBash,
  headless: state.headless,
  testCommand: state.testCommand,
  noTest: state.noTest,
  configPath: state.configPath,
})

/** The full service stack one smith session runs on — the NEW LINE: engine
 *  ports, providers at the edge. Conversations persist to the workspace's own
 *  `.efferent/smith.db`; the coder is the engine's direct loop (no fleet, no
 *  approval judge — the forge loop + gates bound the work). */
export const smithAppLive = (run: SmithRunConfig) =>
  Layer.mergeAll(
    SqliteConversationStoreLive(join(run.cwd, ".efferent", "smith.db")),
    LocalFileSystemLive,
    LocalShellLive,
    LanguageModelLive,
  UtilityLlmLive,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LocalAuthStoreLive(run.cwd, homedir()),
        SmithSettingsStoreLive(run, run.cwd, homedir()),
      ),
    ),
  )

const isDirectRun = process.argv[1]?.endsWith("main.ts") === true
if (isDirectRun) {
  const state = parseArgs(process.argv.slice(2))
  const task = Option.getOrUndefined(state.task)
  if (state.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const command = Option.getOrUndefined(state.command)
  const bare = task === undefined && command === undefined
  const bareInteractive = bare && !state.headless && process.stdout.isTTY === true
  if ((bare && !bareInteractive) || state.errors.length > 0) {
    state.errors.forEach((error) => console.error(`smith: ${error}`))
    console.error(USAGE)
    process.exit(2)
  }
  const run = toRunConfig(state, task ?? "")
  const interactive = !run.headless && process.stdout.isTTY === true
  // Bun auto-loads the LAUNCH dir's .env, and smith always launches from the
  // efferent repo root — a stale EFFERENT_MODEL there would silently override
  // the smith general default for EVERY target workspace (live-caught: the repo
  // .env's gemini seed hijacked a kimi run). Smith's model defaults REPLACE the
  // env-seed tier: flags > .efferent/config.json > smith defaults.
  const envModel = process.env["EFFERENT_MODEL"]
  if (envModel !== undefined) {
    console.error(
      `smith: ignoring EFFERENT_MODEL=${envModel} — use --model or .efferent/config.json`,
    )
    delete process.env["EFFERENT_MODEL"]
  }
  const program = Effect.gen(function* () {
    const settings = yield* SettingsStore
    const resolved = yield* settings.load
    const role = (value: Option.Option<string>): string =>
      Option.getOrElse(value, () => "(unset)")
    if (!interactive) {
      // The resolved roles, on stderr (stdout is the event stream) — user
      // config/flags OVERRIDE the smith defaults, so say what actually runs.
      console.error(
        `roles: general ${role(resolved.model)} · code ${role(resolved.codeModel)} · fast ${role(resolved.fastModel)}`,
      )
    }

    // Bare `smith [--cwd]` on a TTY — the persistent workspace session.
    if (bareInteractive) {
      const { runTuiWorkspace } = yield* Effect.promise(() => import("./tui/runtime.js"))
      return yield* runTuiWorkspace(run)
    }

    // `smith spec "<idea>"` — the refine pipeline.
    if (command === "spec") {
      if (task === undefined) {
        console.error("smith: spec needs an idea — smith spec \"<rough idea>\"")
        return 2
      }
      if (interactive) {
        const { runTuiRefine } = yield* Effect.promise(() => import("./tui/runtime.js"))
        return yield* runTuiRefine(run, task, state.yes)
      }
      return yield* runHeadlessRefine(run.cwd, task, state.yes)
    }

    // `smith forge <slug|path>` — a LOCKED spec drives the run.
    // `smith "<task>"` — shorthand: a trivial locked spec, written for provenance.
    const doc = yield* Effect.gen(function* () {
      if (command === "forge") {
        if (task === undefined) {
          return yield* Effect.fail(
            new ConfigError({ path: run.cwd, message: "forge needs a spec — smith forge <slug|spec.md>" }),
          )
        }
        const loaded = yield* loadSpecDoc(run.cwd, task)
        if (loaded.status !== "locked") {
          return yield* Effect.fail(
            new ConfigError({
              path: task,
              message: `spec "${loaded.slug}" is a DRAFT — refine and lock it first (smith spec, then :lock / --yes)`,
            }),
          )
        }
        return loaded
      }
      const slug = yield* mintUniqueSlug(run.cwd, run.task)
      const trivial = yield* trivialSpecDoc(run, slug, new Date().toISOString())
      yield* writeSpecDoc(run.cwd, trivial)
      return trivial
    })
    const forgeRun: SmithRunConfig = { ...run, task: doc.goal }

    if (!interactive) return yield* runHeadless(forgeRun, Option.some(doc))
    // Lazy: the TUI path touches @opentui/core's native FFI renderer — the
    // headless path must never load it.
    const { runTui } = yield* Effect.promise(() => import("./tui/runtime.js"))
    return yield* runTui(forgeRun, Option.some(doc))
  }).pipe(
    Effect.provide(smithAppLive(run)),
    Effect.provide(BunContext.layer),
    // Effect's default logger writes to STDOUT (console.log): in headless mode
    // that pollutes the event stream, and in the TUI it bleeds raw log lines
    // straight through the OpenTUI frame (live-caught). Headless → stderr;
    // TUI → silenced (any console write corrupts the alt screen).
    Effect.provide(
      interactive
        ? Logger.replace(Logger.defaultLogger, Logger.none)
        : Logger.replace(Logger.defaultLogger, Logger.prettyLogger({ stderr: true })),
    ),
    // A layer-build failure (store selection, migration) is an infra error.
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        console.error(`smith: ${String(cause)}`)
        return 2
      }),
    ),
  )
  process.exit(await Effect.runPromise(program))
}
