#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import {
  AuthStore,
  codeModelDistinct,
  SettingsStore,
  type Scope,
} from "@xandreed/sdk-core"
import {
  AuthFlowLive,
  ClaudeHeadlessVerifierLive,
  HttpLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  ModelRegistryLive,
  OtlpTelemetryLive,
  resolveConfigRoots,
  SwitchableStoresLive,
  TmuxTerminalSessionLive,
  UtilityLlmLive,
  WebSearchLive,
} from "@xandreed/sdk-adapters"

import { coderPrompt } from "./prompts/coder.js"
import { discoverScopeTree } from "@xandreed/sdk-core"
import { discoverInstructionFiles } from "./usecases/discoverInstructionFiles.js"
import { withBuiltinAgents } from "./usecases/directive.js"
import { loadAgents } from "./usecases/loadAgents.js"
import { loadTools } from "@xandreed/sdk-core"
import { loadMemory } from "./usecases/loadMemory.js"
import { loadSkills } from "./usecases/loadSkills.js"

import { runPrintMode } from "./modes/print.js"
import { runJsonMode } from "./modes/json.js"
import { runRpcMode } from "./modes/rpc.js"
import { runDaemonMode } from "./modes/daemon.js"
import { runDaemonServe } from "./server/daemon.js"
import { readDiscovery } from "./server/discovery.js"
import { probeHealth } from "./server/attach.js"
import { stderrLoggerLayer, fileLoggerLayer } from "./log.js"

/* ------------------------------------------------------------------ */
/* Composition root                                                    */
/* ------------------------------------------------------------------ */

// Credentials + settings feed the model/search tiers. Both are provided at the
// bottom so `ModelLive` (AuthStore + SettingsStore) and `WebSearchLive`
// (AuthStore) resolve against them, and both stay exposed for `main` to read.
const CredentialsLive = Layer.mergeAll(
  LocalAuthStoreLive,
  LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
)

const AppLive = Layer.mergeAll(
  // ConversationStore + ContextTreeStore as a runtime-switchable facade (+ the
  // StoreSwitch control port) so the active database can change with no restart.
  SwitchableStoresLive,
  ModelLive,
  LocalFileSystemLive,
  LocalShellLive,
  // Interactive terminal sessions (tmux), backed by the Shell port — the coding
  // toolkit's session_* tools resolve this. Feature-detected: no tmux ⇒ the tools
  // return a graceful failure (NoopTerminalSessionLive is used in evals/tests).
  TmuxTerminalSessionLive.pipe(Layer.provide(LocalShellLive)),
  HttpLive,
  // OAuth protocol port — dependency-free; the `:login` driver uses it instead
  // of reaching into adapter OAuth internals.
  AuthFlowLive,
  // Web search is its own grounding-only provider call (Gemini/OpenAI),
  // configured independently of the chat model — it resolves its key from the
  // AuthStore (below) and carries its own HTTP client.
  WebSearchLive.pipe(Layer.provide(FetchHttpClient.layer)),
  // The fast helper tier (session titles, summaries, approvals): Settings.fastModel,
  // falling back to the chat selection — needs its own ModelRegistry read for that
  // fallback, hence the local registry + HTTP client.
  UtilityLlmLive.pipe(
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
  // The self-improving loop's verify gate — Opus via the real `claude` headless
  // CLI over the Shell port (see docs/self-improving-loop.md). Cheap to build
  // (no `claude` spawned until `efferent distill` calls `refute`), so it lives in
  // the shared AppLive even though only `distill` uses it.
  ClaudeHeadlessVerifierLive.pipe(Layer.provide(LocalShellLive)),
).pipe(Layer.provideMerge(CredentialsLive))

/**
 * Whether to export OpenTelemetry for this session is driven SOLELY by the
 * persisted `telemetry` setting (`:set telemetry on`, or `telemetry: true` in
 * config.json) — read through the `SettingsStore` whose schema defaults it off,
 * not from any env var. The tracer layer is chosen from that one read at
 * composition time; off ⇒ no tracer, so the instrumented spans/metrics are
 * no-ops with zero overhead. (The OTLP endpoint still defaults to
 * `http://localhost:4318`, `OTEL_EXPORTER_OTLP_ENDPOINT` to override — that's
 * WHERE to send, not WHETHER.)
 */
const TelemetryLive: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).load(process.cwd(), homedir())
    return settings.telemetry === true ? OtlpTelemetryLive : Layer.empty
  }).pipe(Effect.orElseSucceed(() => Layer.empty)),
).pipe(Layer.provide(LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive))))

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

const promptArg = Args.text({ name: "prompt" }).pipe(
  Args.optional,
  Args.withDescription(
    "Initial prompt. If present (or piped via stdin), runs print mode and exits.",
  ),
)

const modeOption = Options.choice("mode", [
  "auto",
  "tui",
  "print",
  "json",
  "rpc",
  "daemon",
  "daemon-serve",
]).pipe(
  Options.withDefault("auto" as const),
  Options.withDescription(
    "Output mode. 'auto' picks: stdin-piped → print, prompt arg → print, TTY → tui, else print. 'daemon' runs the cron scheduler headlessly; 'daemon-serve' runs the persistent per-workspace Workspace daemon (HTTP/SSE) that TUI/web clients attach to.",
  ),
)

const printOption = Options.boolean("print").pipe(
  Options.withAlias("p"),
  Options.withDescription("Shortcut for --mode print."),
)

const allowBashOption = Options.boolean("allow-bash").pipe(
  Options.withDescription(
    "In non-interactive modes, allow the agent to run bash without confirmation.",
  ),
)

const resumeOption = Options.text("resume").pipe(
  Options.optional,
  Options.withDescription("Resume an existing conversation by id (UUID)."),
)

const fleetOption = Options.text("fleet").pipe(
  Options.optional,
  Options.withDescription(
    "Attach the coder TUI to a specific fleet's coordinator (a root session id). " +
      "With several fleets and no --fleet, the daemon's active fleet is used.",
  ),
)
const cwdOption = Options.text("cwd").pipe(
  Options.optional,
  Options.withDescription(
    "Override the workspace directory. Defaults to process.cwd().",
  ),
)

// ── `efferent verify` options ──────────────────────────────────────────────
const verifyTargetOption = Options.text("target").pipe(
  Options.optional,
  Options.withDescription(
    "What to verify: 'source' (this working tree, default), 'commit:<sha>', " +
      "'release:<ver>' or 'npm:<spec>' (a clean-room npm install in Docker).",
  ),
)
const verifyModelOption = Options.text("model").pipe(
  Options.optional,
  Options.withDescription(
    "Model for the keyed turns + judge (default opencode:deepseek-v4-flash).",
  ),
)
const verifyTierOption = Options.choice("tier", ["A", "B", "C", "all"]).pipe(
  Options.withDefault("all" as const),
  Options.withDescription(
    "Highest tier to run (A=deterministic always runs; B adds keyed turns; C adds the eval smoke).",
  ),
)
const verifyStrictOption = Options.boolean("strict").pipe(
  Options.withDescription("Promote Tier-C (and other soft) results to hard fails."),
)
const verifyJsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit the structured report as JSON."),
)
const verifyKeepOption = Options.boolean("keep").pipe(
  Options.withDescription("Keep temp workspaces / containers for debugging."),
)

// ── `efferent eval` passthrough options (forwarded to the evals runner) ─────
const evalSuitesArg = Args.text({ name: "suite" }).pipe(
  Args.repeated,
  Args.withDescription("Suite names to run (empty = all)."),
)
const evalMainOption = Options.text("main").pipe(Options.optional)
const evalFastOption = Options.text("fast").pipe(Options.optional)
const evalJudgeOption = Options.text("judge").pipe(Options.optional)
const evalSamplesOption = Options.text("samples").pipe(Options.optional)
const evalConfigOption = Options.text("config").pipe(Options.optional)
const evalJsonOption = Options.boolean("json").pipe(
  Options.withDescription("Emit the eval report as JSON."),
)

// ── `efferent distill` options (the self-improving loop) ────────────────────
const distillSinceOption = Options.text("since").pipe(
  Options.optional,
  Options.withDescription("Only mine conversations created on/after this date (YYYY-MM-DD)."),
)
const distillConversationOption = Options.text("conversation").pipe(
  Options.optional,
  Options.withDescription("Mine a single conversation by id (or id prefix)."),
)
const distillDryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Show candidate learnings without verifying or writing anything."),
)
const distillLimitOption = Options.text("limit").pipe(
  Options.optional,
  Options.withDescription("Cap how many conversations to mine (most recent first)."),
)
const distillThresholdOption = Options.text("threshold").pipe(
  Options.optional,
  Options.withDescription("Accept score cutoff for the Opus verify gate (0–1, default 0.7)."),
)

type Mode = "tui" | "print" | "json" | "rpc" | "daemon" | "daemon-serve"

const resolveMode = (
  modeFlag: "auto" | Mode,
  printFlag: boolean,
  hasPromptArg: boolean,
): Mode => {
  if (modeFlag !== "auto") return modeFlag
  if (printFlag) return "print"
  if (hasPromptArg) return "print"
  const isTty = Boolean((process.stdout as { isTTY?: boolean }).isTTY)
  return isTty ? "tui" : "print"
}

const readStdinIfPiped = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream
    if (stdin.isTTY) {
      resolve(undefined)
      return
    }
    let buf = ""
    stdin.setEncoding("utf8")
    stdin.on("data", (chunk: string) => {
      buf += chunk
    })
    stdin.on("end", () => resolve(buf))
    stdin.on("error", () => resolve(undefined))
  })

/**
 * Discover the workspace's skills / agent roles / declarative tools / instruction
 * files / scope tree — shared by the coder modes and `daemon serve` so both build
 * the agent from the same picture. Requires the app services (the caller provides
 * `AppLive`).
 */
const discoverWorkspace = (workspace: string) =>
  Effect.gen(function* () {
    const skills = yield* loadSkills(workspace, homedir())
    const memory = yield* loadMemory(workspace, homedir())
    // Whether a distinct `code` model is configured — gates the root's
    // code-delegation policy (write code on the `code` tier, not directly).
    // `coderAgentConfig` uses THIS rootScope's systemPrompt for every mode, so
    // computing it here threads the policy everywhere (TUI / daemon / print /
    // json / rpc). Read at startup; a mid-session `:set codeModel` takes effect
    // on the next launch (the prompt is built once, like the rest of the scope).
    const settings = yield* (yield* SettingsStore).load(workspace, homedir())
    // The self-improving loop knobs shape the built-in coordinator: autoLoop
    // toggles the Opus gate + learn/retry phase, maxLoopAttempts the round cap.
    const agents = withBuiltinAgents(yield* loadAgents(workspace, homedir()), {
      autoLoop: settings.autoLoop !== false,
      maxLoopAttempts: settings.maxLoopAttempts ?? 3,
    })
    const tools = yield* loadTools(workspace, homedir())
    const instructionFiles = yield* discoverInstructionFiles(workspace, homedir())
    const root = coderPrompt(
      workspace,
      new Date(),
      skills,
      instructionFiles,
      agents,
      tools,
      undefined,
      memory,
      codeModelDistinct(settings),
    )
    const rootScope: Scope = yield* discoverScopeTree(workspace, (_children, body) =>
      body !== undefined && body.trim().length > 0
        ? `${root.text}\n\n# Project scope\n\n${body}`
        : root.text,
    )
    return { skills, memory, agents, tools, instructionFiles, rootScope }
  })

const root = Command.make(
  "efferent",
  {
    prompt: promptArg,
    mode: modeOption,
    print: printOption,
    allowBash: allowBashOption,
    resume: resumeOption,
    cwd: cwdOption,
    fleet: fleetOption,
  },
  ({ prompt, mode, print, allowBash, resume, cwd, fleet }) =>
    Effect.gen(function* () {
      const workspace =
        resume._tag === "Some" || cwd._tag === "Some"
          ? cwd._tag === "Some"
            ? cwd.value
            : process.cwd()
          : process.cwd()

      // Seed DB config from the resolved workspace dir (not process.cwd(),
      // which may differ when --cwd is in effect). This must happen before
      // any service layer is built, since the store selector reads the env var.
      yield* Effect.sync(() => seedDbUrlFromConfig(workspace))

      const resumeId = resume._tag === "Some" ? resume.value : undefined
      const promptArgValue = prompt._tag === "Some" ? prompt.value : undefined

      // For non-RPC/TUI modes, if stdin is piped and no prompt arg,
      // swallow stdin as the prompt. RPC needs stdin for its protocol;
      // TUI needs stdin for keystrokes.
      const skipStdin = mode === "rpc" || mode === "tui" || mode === "daemon-serve"
      const piped =
        skipStdin || promptArgValue !== undefined
          ? undefined
          : yield* Effect.promise(() => readStdinIfPiped())
      const effectivePrompt =
        promptArgValue ?? (piped !== undefined && piped.trim().length > 0 ? piped : undefined)

      const chosen: Mode = resolveMode(
        mode,
        print,
        effectivePrompt !== undefined,
      )

      // Discover skills / agent roles / declarative tools / instruction files /
      // scope tree (the same picture `daemon serve` builds — shared helper).
      const { skills, memory, agents, tools, instructionFiles, rootScope } =
        yield* discoverWorkspace(workspace)

      // Load settings + bind the workspace so AuthStore can read a local-tier
      // credential (`<cwd>/.efferent/auth.json`); no-op in the EFFERENT_HOME sandbox.
      const settingsStore = yield* SettingsStore
      const settings = yield* settingsStore.load(workspace, homedir())
      yield* (yield* AuthStore).init(workspace)
      const effectiveAllowBash = allowBash || settings.allowBash

      // Non-interactive modes can't run the in-app `:login` flow, so they need
      // a credential already in ~/.efferent/auth.json (written by a prior TUI
      // `:login`). The TUI itself boots regardless and guides the user there.
      const ensureBatchCredential = Effect.gen(function* () {
        const all = yield* (yield* AuthStore).all
        if (Object.keys(all).length === 0) {
          process.stderr.write(
            "efferent: no provider configured. Run `efferent` (TUI) and `:login` to add one,\n" +
              "then re-run — it reads ~/.efferent/auth.json.\n",
          )
          process.exit(1)
        }
      })

      switch (chosen) {
        case "print":
          if (effectivePrompt === undefined) {
            yield* Effect.sync(() => {
              process.stderr.write(
                "efferent: print mode needs a prompt (argv or stdin)\n",
              )
              process.exit(1)
            })
            return
          }
          yield* ensureBatchCredential
          yield* runPrintMode({
            prompt: effectivePrompt,
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            allowBash: effectiveAllowBash,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          }).pipe(Effect.provide(stderrLoggerLayer))
          return
        case "json":
          if (effectivePrompt === undefined) {
            yield* Effect.sync(() => {
              process.stderr.write(
                "efferent: json mode needs a prompt (argv or stdin)\n",
              )
              process.exit(1)
            })
            return
          }
          yield* ensureBatchCredential
          yield* runJsonMode({
            prompt: effectivePrompt,
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            allowBash: effectiveAllowBash,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          }).pipe(Effect.provide(stderrLoggerLayer))
          return
        case "rpc":
          yield* ensureBatchCredential
          yield* runRpcMode({
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            allowBash: effectiveAllowBash,
          }).pipe(Effect.provide(stderrLoggerLayer))
          return
        case "daemon":
          // Headless scheduler: needs a credential (no `:login` here) just like
          // the other non-interactive modes; then runs the cron tick forever.
          yield* ensureBatchCredential
          yield* runDaemonMode({
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            allowBash: effectiveAllowBash,
          }).pipe(Effect.provide(fileLoggerLayer))
          return
        case "daemon-serve":
          // The persistent per-workspace Workspace daemon (HTTP/SSE). Boots
          // credential-less on purpose — clients add a provider in-session and
          // the router resolves the key per request from auth.json — so a long-
          // lived daemon survives logins/logouts. Serves until interrupted.
          yield* runDaemonServe({
            workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            instructionFiles,
            version: packageJson.version,
            allowBash: effectiveAllowBash,
          }).pipe(Effect.provide(fileLoggerLayer))
          return
        case "tui": {
          // The default `efferent`/`eff` invocation: the master assistant
          // (`variant: "master"`) — a thin client that attaches to the per-
          // workspace daemon over HTTP/SSE, auto-spawning it if absent (the
          // tmux-style default, same as `efferent attach`). `EFFERENT_LOCAL=1`
          // forces the in-process driver instead (the backend `efferent code`
          // always uses); the focused single-fleet coder is the `efferent code`
          // subcommand. `EFFERENT_REMOTE` stays accepted as an explicit alias.
          // The startup conversation picker lives inside the TUI (an overlay
          // over the live agent), so we only pass an explicit --resume.
          const tuiInput = {
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            instructionFiles,
            variant: "master" as const,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
            ...(fleet._tag === "Some" ? { fleetId: fleet.value } : {}),
          }
          // The TUI (OpenTUI + SolidJS), loaded lazily so the native
          // @opentui/core FFI lib is touched ONLY on this path — print/json/rpc
          // never import it.
          const local = (process.env.EFFERENT_LOCAL ?? "").trim().length > 0
          const runTui = local
            ? (yield* Effect.promise(() => import("./cli/runtime.js"))).runTuiModeSolid
            : (yield* Effect.promise(() => import("./cli/remoteRuntime.js"))).runTuiModeRemote
          yield* runTui(tuiInput).pipe(Effect.catchAllDefect(tuiStartupFailure))
          return
        }
      }
    }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive)),
)

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve the boot connection from a config.json: the named `defaultDatabase`
 * (looked up in `databases`) wins, else the legacy `dbUrl`. Returns the
 * connection url (empty ⇒ the implicit local SQLite) and its name, used to seed
 * the boot-time store selector (which reads env, at layer-build, before settings
 * load). A `defaultDatabase: "local"` yields just the name (no url).
 */
const readSeed = (p: string): { url?: string; name?: string } | undefined => {
  try {
    if (!existsSync(p)) return undefined
    const cfg = JSON.parse(readFileSync(p, "utf8")) as {
      dbUrl?: unknown
      defaultDatabase?: unknown
      databases?: Record<string, { url?: unknown }>
    }
    if (typeof cfg.defaultDatabase === "string" && cfg.defaultDatabase.length > 0) {
      const name = cfg.defaultDatabase
      const entry = cfg.databases?.[name]
      if (entry !== undefined && typeof entry.url === "string" && entry.url.length > 0) {
        return { url: entry.url, name }
      }
      return { name } // a named (e.g. "local") default with no explicit url
    }
    if (typeof cfg.dbUrl === "string" && cfg.dbUrl.length > 0) return { url: cfg.dbUrl }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Seed `EFFERENT_DB_URL` (+ `EFFERENT_DB_NAME`) from config.json when not already
 * in the env, so a config-file DB selection feeds the boot-time store selector.
 * The caller passes the resolved workspace dir so the lookup matches `--cwd`.
 * Workspace `<cwd>/.efferent` overrides global `~/.efferent` (SettingsStore
 * layering). A real `EFFERENT_DB_URL` env var always wins.
 */
const seedDbUrlFromConfig = (workspaceDir: string): void => {
  if (process.env.EFFERENT_DB_URL) return
  const roots = resolveConfigRoots(workspaceDir)
  const seed =
    (roots.local !== undefined ? readSeed(join(roots.local, "config.json")) : undefined) ??
    readSeed(join(roots.global, "config.json"))
  if (seed === undefined) return
  if (seed.url !== undefined && seed.url.length > 0) process.env.EFFERENT_DB_URL = seed.url
  if (seed.name !== undefined && process.env.EFFERENT_DB_NAME === undefined) {
    process.env.EFFERENT_DB_NAME = seed.name
  }
}

// No boot gate: efferent always launches into the TUI. With no credential it
// shows a "run :login" warning (see runTuiMode) and configures providers in
// session via the in-app `:login` flow — credentials live only in
// ~/.efferent/auth.json, never the env. Non-interactive modes (print/json/rpc)
// gate on that file via `ensureBatchCredential` instead.
// Single source of truth for the version: the package manifest. Bun inlines
// the JSON at bundle time, so the published artifact reports its real version.
import packageJson from "../package.json" with { type: "json" }

/* ------------------------------------------------------------------ */
/* `daemon` command group — the control plane (cluster) operations      */
/* ------------------------------------------------------------------ */

// Default workspace = the explicit --cwd, else EFFERENT_CWD, else process.cwd().
// EFFERENT_CWD lets the dev `bin/efferent` launcher run Bun WITH the repo as cwd
// (so it resolves Solid's jsxImportSource from this repo's tsconfig) while still
// operating on the user's real directory. Unset in normal/published runs ⇒ no
// change (falls through to process.cwd()).
const resolveCwd = (cwd: Option.Option<string>): string =>
  Option.getOrElse(cwd, () => process.env.EFFERENT_CWD ?? process.cwd())

// Print the daemon's running/health status for a workspace. Shared by
// `efferent daemon status` and bare `efferent daemon`.
const printDaemonStatus = (workspace: string) =>
  Effect.gen(function* () {
    const info = yield* readDiscovery(workspace)
    if (info === undefined) {
      yield* Effect.sync(() => process.stdout.write(`no daemon running for ${workspace}\n`))
      return
    }
    const healthy = yield* probeHealth(`http://127.0.0.1:${info.port}`)
    yield* Effect.sync(() =>
      process.stdout.write(
        `daemon pid ${info.pid} · 127.0.0.1:${info.port} · ${healthy ? "healthy" : "unreachable"}\n`,
      ),
    )
  })

/**
 * Resolve + bootstrap a workspace for a subcommand: seed the DB selector from
 * config (before any store is built), discover the agent picture, load settings,
 * and bind AuthStore to the workspace. Shared by `efferent code` / `attach` /
 * `daemon start`. Requires AppServices (the caller provides AppLive).
 */
const prepareWorkspace = (cwd: Option.Option<string>) =>
  Effect.gen(function* () {
    const workspace = resolveCwd(cwd)
    yield* Effect.sync(() => seedDbUrlFromConfig(workspace))
    const discovered = yield* discoverWorkspace(workspace)
    const settings = yield* (yield* SettingsStore).load(workspace, homedir())
    yield* (yield* AuthStore).init(workspace)
    return { workspace, settings, ...discovered }
  })

// Surface a clear error and exit non-zero when the native OpenTUI renderer can't
// start (e.g. its platform lib is missing), instead of crashing with a defect.
// Shared by every TUI entrypoint: the root `efferent`, `code`, and `attach`.
const tuiStartupFailure = (defect: unknown) =>
  Effect.sync(() => {
    process.stderr.write(
      `efferent: the terminal UI failed to start (${String(defect)}). ` +
        `It needs @opentui/core's native library for this platform; ` +
        `use --print / --mode json / --mode rpc for non-interactive runs.\n`,
    )
    process.exitCode = 1
  })

// The persistent per-workspace HTTP/SSE daemon (today's `--mode daemon-serve`).
// Boots credential-less on purpose — clients add a provider in-session and the
// router resolves the key per request — so a long-lived daemon survives
// logins/logouts. Backs both `daemon start` and the `serve` alias.
const runServe = (cwd: Option.Option<string>, allowBash: boolean) =>
  Effect.gen(function* () {
    const { workspace, settings, skills, memory, agents, tools, instructionFiles, rootScope } =
      yield* prepareWorkspace(cwd)
    yield* runDaemonServe({
      workspace,
      skills,
      memory,
      agents,
      tools,
      rootScope,
      instructionFiles,
      version: packageJson.version,
      allowBash: allowBash || settings.allowBash,
    }).pipe(Effect.provide(stderrLoggerLayer))
  }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive))

// `efferent daemon start` — run the persistent per-workspace daemon (HTTP/SSE)
// that TUI/web clients attach to. `serve` is kept as an accepted alias (it's
// also the auto-spawn target in server/attach.ts).
const daemonStartCommand = Command.make(
  "start",
  { cwd: cwdOption, allowBash: allowBashOption },
  ({ cwd, allowBash }) => runServe(cwd, allowBash),
)
const daemonServeCommand = Command.make(
  "serve",
  { cwd: cwdOption, allowBash: allowBashOption },
  ({ cwd, allowBash }) => runServe(cwd, allowBash),
)

// `efferent daemon status` — is a daemon running for this workspace + healthy?
const daemonStatusCommand = Command.make("status", { cwd: cwdOption }, ({ cwd }) =>
  printDaemonStatus(resolveCwd(cwd)),
)

// `efferent daemon stop` — graceful shutdown via the daemon's /shutdown.
const daemonStopCommand = Command.make("stop", { cwd: cwdOption }, ({ cwd }) =>
  Effect.gen(function* () {
    const workspace = resolveCwd(cwd)
    const info = yield* readDiscovery(workspace)
    if (info === undefined) {
      yield* Effect.sync(() => process.stdout.write(`no daemon to stop for ${workspace}\n`))
      return
    }
    yield* Effect.tryPromise(() =>
      fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: "POST" }),
    ).pipe(Effect.ignore)
    yield* Effect.sync(() => process.stdout.write("shutdown requested\n"))
  }),
)

// `efferent daemon` (no subcommand) — print the daemon's status for this
// workspace (same output as `efferent daemon status`). The chat-first TUI's
// fleet-tree pane replaced the old k9s-style control dashboard, so there is no
// longer a dashboard to open here.
const daemonCommand = Command.make("daemon", { cwd: cwdOption }, ({ cwd }) =>
  printDaemonStatus(resolveCwd(cwd)),
).pipe(
  Command.withSubcommands([
    daemonStartCommand,
    daemonServeCommand,
    daemonStatusCommand,
    daemonStopCommand,
  ]),
)

// `efferent code` — the focused single-fleet coder. ALWAYS the in-process driver
// (its own in-memory Workspace), `variant: "code"`. Replaces the old `code` bin
// + `--code` flag; EFFERENT_LOCAL is irrelevant here (this path is always local).
const codeCommand = Command.make(
  "code",
  { cwd: cwdOption, resume: resumeOption },
  ({ cwd, resume }) =>
    Effect.gen(function* () {
      const { workspace, skills, memory, agents, tools, instructionFiles, rootScope } =
        yield* prepareWorkspace(cwd)
      const tuiInput = {
        cwd: workspace,
        skills,
        memory,
        agents,
        tools,
        rootScope,
        instructionFiles,
        variant: "code" as const,
        ...(resume._tag === "Some" ? { resumeConversationId: resume.value } : {}),
      }
      const { runTuiModeSolid } = yield* Effect.promise(() => import("./cli/runtime.js"))
      yield* runTuiModeSolid(tuiInput).pipe(Effect.catchAllDefect(tuiStartupFailure))
    }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive)),
)

// `efferent attach` — explicitly attach the master TUI to the workspace daemon
// (auto-spawn if absent). Always the remote driver, regardless of EFFERENT_LOCAL;
// this is the same path the bare `efferent` invocation takes by default.
const attachCommand = Command.make(
  "attach",
  { cwd: cwdOption, resume: resumeOption, fleet: fleetOption },
  ({ cwd, resume, fleet }) =>
    Effect.gen(function* () {
      const { workspace, skills, memory, agents, tools, instructionFiles, rootScope } =
        yield* prepareWorkspace(cwd)
      const tuiInput = {
        cwd: workspace,
        skills,
        memory,
        agents,
        tools,
        rootScope,
        instructionFiles,
        variant: "master" as const,
        ...(resume._tag === "Some" ? { resumeConversationId: resume.value } : {}),
        ...(fleet._tag === "Some" ? { fleetId: fleet.value } : {}),
      }
      const { runTuiModeRemote } = yield* Effect.promise(() => import("./cli/remoteRuntime.js"))
      yield* runTuiModeRemote(tuiInput).pipe(Effect.catchAllDefect(tuiStartupFailure))
    }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive)),
)

// `efferent verify` — the graded acceptance battery (boot/UI-flows/daemon are
// deterministic; the keyed turns + eval smoke use the cheap model). Lazy-imports
// the verify module so its test/docker deps stay off the normal boot path.
const verifyCommand = Command.make(
  "verify",
  {
    target: verifyTargetOption,
    model: verifyModelOption,
    tier: verifyTierOption,
    strict: verifyStrictOption,
    json: verifyJsonOption,
    keep: verifyKeepOption,
  },
  ({ target, model, tier, strict, json, keep }) =>
    Effect.gen(function* () {
      const { runVerify } = yield* Effect.promise(() => import("./verify/run.js"))
      yield* runVerify({
        target: Option.getOrUndefined(target),
        model: Option.getOrUndefined(model),
        tier,
        strict,
        json,
        keep,
      })
    }),
)

// `efferent eval` — first-class access to the eval suites (forwarded to the
// evals runner; runs from a source checkout).
const evalCommand = Command.make(
  "eval",
  {
    suites: evalSuitesArg,
    main: evalMainOption,
    fast: evalFastOption,
    judge: evalJudgeOption,
    samples: evalSamplesOption,
    config: evalConfigOption,
    json: evalJsonOption,
  },
  ({ suites, main, fast, judge, samples, config, json }) =>
    Effect.gen(function* () {
      const { runEvalForward } = yield* Effect.promise(() => import("./verify/eval.js"))
      yield* runEvalForward({
        suites,
        main: Option.getOrUndefined(main),
        fast: Option.getOrUndefined(fast),
        judge: Option.getOrUndefined(judge),
        samples: Option.getOrUndefined(samples),
        config: Option.getOrUndefined(config),
        json,
      })
    }),
)

// `efferent distill` — the self-improving loop (docs/self-improving-loop.md):
// mine finished conversations from the DB for reusable learnings on the cheap
// fast tier, refute each with the Opus verify gate (`claude` headless), and
// persist survivors as skills/memory/constraints the next run auto-loads.
// `--dry-run` skips the gate + writes entirely (no `claude`, no cost).
const distillCommand = Command.make(
  "distill",
  {
    cwd: cwdOption,
    since: distillSinceOption,
    conversation: distillConversationOption,
    dryRun: distillDryRunOption,
    limit: distillLimitOption,
    threshold: distillThresholdOption,
  },
  ({ cwd, since, conversation, dryRun, limit, threshold }) =>
    Effect.gen(function* () {
      const workspace = resolveCwd(cwd)
      yield* Effect.sync(() => seedDbUrlFromConfig(workspace))
      const limitN = Option.getOrUndefined(limit)
      const thresholdN = Option.getOrUndefined(threshold)
      const { runDistill } = yield* Effect.promise(() => import("./distill/run.js"))
      yield* runDistill({
        workspace,
        dryRun,
        ...(since._tag === "Some" ? { since: since.value } : {}),
        ...(conversation._tag === "Some" ? { conversation: conversation.value } : {}),
        ...(limitN !== undefined ? { limit: Number.parseInt(limitN, 10) } : {}),
        ...(thresholdN !== undefined ? { threshold: Number.parseFloat(thresholdN) } : {}),
      })
    }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive)),
)

const cli = Command.run(
  root.pipe(
    Command.withSubcommands([
      codeCommand,
      attachCommand,
      daemonCommand,
      verifyCommand,
      evalCommand,
      distillCommand,
    ]),
  ),
  {
    name: "efferent",
    version: packageJson.version,
  },
)

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
