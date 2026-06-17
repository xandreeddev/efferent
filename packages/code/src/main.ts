#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  AuthStore,
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
  StoresLive,
  UtilityLlmLive,
  WebSearchLive,
} from "@xandreed/sdk-adapters"

import { coderPrompt } from "./prompts/coder.js"
import { discoverInstructionFiles } from "./usecases/discoverInstructionFiles.js"
import { discoverScopeTree } from "./usecases/discoverScopeTree.js"
import { loadSkills } from "./usecases/loadSkills.js"

import { runPrintMode } from "./modes/print.js"
import { runJsonMode } from "./modes/json.js"
import { runRpcMode } from "./modes/rpc.js"
import { stderrLoggerLayer } from "./log.js"

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
  // Both SQL stores (ConversationStore + ContextTreeStore) over one DB stack.
  StoresLive,
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
]).pipe(
  Options.withDefault("auto" as const),
  Options.withDescription(
    "Output mode. 'auto' picks: stdin-piped → print, prompt arg → print, TTY → tui, else print.",
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

const cwdOption = Options.text("cwd").pipe(
  Options.optional,
  Options.withDescription(
    "Override the workspace directory. Defaults to process.cwd().",
  ),
)

type Mode = "tui" | "print" | "json" | "rpc"

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

const root = Command.make(
  "efferent",
  {
    prompt: promptArg,
    mode: modeOption,
    print: printOption,
    allowBash: allowBashOption,
    resume: resumeOption,
    cwd: cwdOption,
  },
  ({ prompt, mode, print, allowBash, resume, cwd }) =>
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
      const skipStdin = mode === "rpc" || mode === "tui"
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

      // Discover skills once at startup. `.efferent/skills/*.md` walked from
      // cwd → parents → ~/.efferent/skills. Closer-to-cwd shadows farther.
      // Failures fall back to an empty list — never breaks the agent.
      const skills = yield* loadSkills(workspace, homedir())

      // Load settings
      const settingsStore = yield* SettingsStore
      const settings = yield* settingsStore.load(workspace, homedir())
      const effectiveAllowBash = allowBash || settings.allowBash

      // Auto-inject AGENT.md / AGENT.local.md from the ancestor chain
      // (root → workspace → home). Per-file 4k char cap; total 12k char
      // cap; dedupe by normalized content. Returns [] when none.
      const instructionFiles = yield* discoverInstructionFiles(
        workspace,
        homedir(),
      )

      // Discover the scope tree from SCOPE.md files. The root is always
      // present (its prompt = built-in coder prompt + any root SCOPE.md
      // body, plus a delegation section for its direct children); each
      // child SCOPE.md becomes a nested, write-confined sub-scope. With no
      // SCOPE.md anywhere, the root has no children and behaves exactly
      // like a plain workspace-wide agent.
      const coder = coderPrompt(workspace, new Date(), skills, instructionFiles)
      const rootScope: Scope = yield* discoverScopeTree(
        workspace,
        (_children, body) => {
          const base = coder.text
          return body !== undefined && body.trim().length > 0
            ? `${base}\n\n# Project scope\n\n${body}`
            : base
        },
      )

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
            rootScope,
            allowBash: effectiveAllowBash,
          }).pipe(Effect.provide(stderrLoggerLayer))
          return
        case "tui": {
          // The startup conversation picker now lives *inside* the TUI (it's an
          // overlay over the live agent), so we only pass an explicit --resume.
          const tuiInput = {
            cwd: workspace,
            skills,
            rootScope,
            instructionFiles,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          }
          // The TUI (OpenTUI + SolidJS), loaded lazily so the native
          // @opentui/core FFI lib is touched ONLY on this path — print/json/rpc
          // never import it. If the native renderer can't start (e.g. its
          // platform lib is missing), surface a clear error and exit non-zero
          // rather than crashing with a defect.
          const { runTuiModeSolid } = yield* Effect.promise(
            () => import("./cli/runtime.js"),
          )
          yield* runTuiModeSolid(tuiInput).pipe(
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
 * Seed `EFFERENT_DB_URL` from config.json (`dbUrl`) when it's not already set
 * in the env, so a config-file DB selection feeds the boot-time store selector
 * (which reads the env var, at layer-build, before settings are loaded).
 * Workspace `<cwd>/.efferent/config.json` overrides the global
 * `~/.efferent/config.json`, matching SettingsStore layering. A real env var
 * always wins — this only fills the gap.
 */
const readDbUrl = (p: string): string | undefined => {
  try {
    if (!existsSync(p)) return undefined
    const cfg = JSON.parse(readFileSync(p, "utf8")) as { dbUrl?: unknown }
    return typeof cfg.dbUrl === "string" && cfg.dbUrl.length > 0
      ? cfg.dbUrl
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Seed `EFFERENT_DB_URL` from config.json (`dbUrl`) when it's not already set
 * in the env. The caller passes the resolved workspace dir so the lookup
 * matches `--cwd`, not `process.cwd()`. A real env var always wins.
 */
const seedDbUrlFromConfig = (workspaceDir: string): void => {
  if (process.env.EFFERENT_DB_URL) return
  const dbUrl =
    readDbUrl(join(workspaceDir, ".efferent", "config.json")) ??
    readDbUrl(join(homedir(), ".efferent", "config.json"))
  if (dbUrl !== undefined) process.env.EFFERENT_DB_URL = dbUrl
}

// No boot gate: efferent always launches into the TUI. With no credential it
// shows a "run :login" warning (see runTuiMode) and configures providers in
// session via the in-app `:login` flow — credentials live only in
// ~/.efferent/auth.json, never the env. Non-interactive modes (print/json/rpc)
// gate on that file via `ensureBatchCredential` instead.
// Single source of truth for the version: the package manifest. Bun inlines
// the JSON at bundle time, so the published artifact reports its real version.
import packageJson from "../package.json" with { type: "json" }

const cli = Command.run(root, {
  name: "efferent",
  version: packageJson.version,
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
