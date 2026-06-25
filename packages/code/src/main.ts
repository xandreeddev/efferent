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

const codeOption = Options.boolean("code").pipe(
  Options.withDescription(
    "Launch the focused single-fleet coder TUI (the `code` bin): in-process " +
      "Workspace + a `code`-branded header + a tree scoped to the one working " +
      "session. Implied when invoked as `code`.",
  ),
)

/**
 * Whether to run the focused `code` experience (vs the `efferent` master
 * assistant). The PRIMARY signal is the `--code` flag, which the installed
 * `code` bin's shim (`dist/code.js`) always injects — Bun resolves a symlinked
 * bin's `argv[1]` to the bundle path, so name-sniffing alone can't catch a
 * `code` invocation, hence the shim. The argv[1] basename check below is a
 * belt-and-suspenders for the dev/source path (`bun …/src/code.ts`).
 *
 * TODO(release): the bin name `code` collides with the VS Code CLI (`code .`).
 * Confirm the published name before cutting a release.
 *
 * The `code` path forces the IN-PROCESS TUI driver (regardless of
 * EFFERENT_LOCAL) with `variant: "code"`; everything else runs the
 * `efferent`/`eff` master variant ("master").
 */
const invokedAsCode = (): boolean => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const base = argv1.split(/[\\/]/).pop() ?? ""
  return base === "code" || base === "code.js" || base === "code.ts"
}

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
    const agents = withBuiltinAgents(yield* loadAgents(workspace, homedir()))
    const tools = yield* loadTools(workspace, homedir())
    const instructionFiles = yield* discoverInstructionFiles(workspace, homedir())
    // Whether a distinct `code` model is configured — gates the root's
    // code-delegation policy (write code on the `code` tier, not directly).
    // `coderAgentConfig` uses THIS rootScope's systemPrompt for every mode, so
    // computing it here threads the policy everywhere (TUI / daemon / print /
    // json / rpc). Read at startup; a mid-session `:set codeModel` takes effect
    // on the next launch (the prompt is built once, like the rest of the scope).
    const settings = yield* (yield* SettingsStore).load(workspace, homedir())
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
    code: codeOption,
  },
  ({ prompt, mode, print, allowBash, resume, cwd, fleet, code }) =>
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
          // The `code` experience: invoked as the `code` bin, or `--code`. It is
          // the focused single-fleet coder — a `code`-branded header and a fleet
          // tree scoped to the one working session. It ALWAYS runs the in-process
          // driver (its own in-memory Workspace, same path EFFERENT_LOCAL=1 uses),
          // independent of the daemon, and carries `variant: "code"`. The default
          // `efferent`/`eff` invocation is the master assistant (`variant:
          // "master"`, the remote daemon driver).
          const codeMode = code || invokedAsCode()
          // The startup conversation picker now lives *inside* the TUI (it's an
          // overlay over the live agent), so we only pass an explicit --resume.
          const tuiInput = {
            cwd: workspace,
            skills,
            memory,
            agents,
            tools,
            rootScope,
            instructionFiles,
            variant: codeMode ? ("code" as const) : ("master" as const),
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
            ...(fleet._tag === "Some" ? { fleetId: fleet.value } : {}),
          }
          // The TUI (OpenTUI + SolidJS), loaded lazily so the native
          // @opentui/core FFI lib is touched ONLY on this path — print/json/rpc
          // never import it. If the native renderer can't start (e.g. its
          // platform lib is missing), surface a clear error and exit non-zero
          // rather than crashing with a defect.
          //
          // The default `efferent` TUI is a thin client that attaches to the
          // per-workspace daemon over HTTP/SSE (auto-spawning it if absent) — the
          // tmux-style default. The in-process driver is the `code` bin's backend
          // AND the legacy `EFFERENT_LOCAL=1` fallback until the remote path has
          // soaked; it is NOT deleted (that final cleanup is gated on a manual
          // attach/detach/restore validation — see docs/daemon-split.md).
          // `EFFERENT_REMOTE` stays accepted as an explicit opt-in alias.
          const local = codeMode || (process.env.EFFERENT_LOCAL ?? "").trim().length > 0
          const runTui = local
            ? (yield* Effect.promise(() => import("./cli/runtime.js"))).runTuiModeSolid
            : (yield* Effect.promise(() => import("./cli/remoteRuntime.js"))).runTuiModeRemote
          yield* runTui(tuiInput).pipe(
            Effect.catchAllDefect((defect) =>
              Effect.sync(() => {
                process.stderr.write(
                  `efferent: the terminal UI failed to start (${String(defect)}). ` +
                    `It needs @opentui/core's native library for this platform; ` +
                    `use --print / --mode json / --mode rpc for non-interactive runs.\n`,
                )
                process.exitCode = 1
              }),
            ),
          )
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

const resolveCwd = (cwd: Option.Option<string>): string =>
  Option.getOrElse(cwd, () => process.cwd())

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

// `efferent daemon serve` — the headless, detached server (today's
// `--mode daemon-serve`, kept dual-accepted as the auto-spawn target).
const daemonServeCommand = Command.make(
  "serve",
  { cwd: cwdOption, allowBash: allowBashOption },
  ({ cwd, allowBash }) =>
    Effect.gen(function* () {
      const workspace = resolveCwd(cwd)
      yield* Effect.sync(() => seedDbUrlFromConfig(workspace))
      const { skills, memory, agents, tools, instructionFiles, rootScope } =
        yield* discoverWorkspace(workspace)
      const settingsStore = yield* SettingsStore
      const settings = yield* settingsStore.load(workspace, homedir())
      yield* (yield* AuthStore).init(workspace)
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
    }).pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive)),
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
  Command.withSubcommands([daemonServeCommand, daemonStatusCommand, daemonStopCommand]),
)

const cli = Command.run(root.pipe(Command.withSubcommands([daemonCommand])), {
  name: "efferent",
  version: packageJson.version,
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
