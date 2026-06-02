#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  coderSystemPrompt,
  ConversationStore,
  discoverInstructionFiles,
  discoverScopeTree,
  loadSkills,
  SettingsStore,
  type Scope,
} from "@efferent/core"
import {
  ConversationStoreLive,
  HttpLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  ProviderClientsLive,
  WebSearchLive,
} from "@efferent/adapters"

import { runPrintMode } from "./modes/print.js"
import { runJsonMode } from "./modes/json.js"
import { runRpcMode } from "./modes/rpc.js"
import { runTuiMode } from "./modes/tui.js"

/* ------------------------------------------------------------------ */
/* Composition root                                                    */
/* ------------------------------------------------------------------ */

const AppLive = Layer.mergeAll(
  ConversationStoreLive,
  ModelLive,
  LocalFileSystemLive,
  LocalShellLive,
  HttpLive,
  // Web search is its own grounding-only provider call (Gemini/OpenAI),
  // configured independently of the chat model — so it carries its own
  // provider clients rather than sharing ModelLive's (which are internal).
  WebSearchLive.pipe(Layer.provide(ProviderClientsLive)),
).pipe(
  Layer.provideMerge(
    LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
  ),
)

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

const promptConversationSelection = (
  list: ReadonlyArray<{
    readonly id: string
    readonly createdAt: number
    readonly firstPrompt?: string
  }>,
): Effect.Effect<string | undefined, never, never> =>
  Effect.gen(function* () {
    console.log(`\nFound existing conversations in this workspace:`)
    list.forEach((c, idx) => {
      const dateStr = new Date(c.createdAt).toLocaleString()
      const preview = c.firstPrompt
        ? `"${c.firstPrompt.trim().replace(/\s+/g, " ").slice(0, 60)}..."`
        : "<empty conversation>"
      console.log(`  [${idx + 1}] ${dateStr} · ${preview}`)
    })
    console.log(`  [n] Start a new conversation\n`)

    const readline = require("node:readline")
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = yield* Effect.promise(() =>
      new Promise<string>((resolve) => {
        rl.question(`Choose a conversation to resume (default: n): `, (ans: string) => {
          rl.close()
          resolve(ans.trim())
        })
      }),
    )

    const num = parseInt(answer, 10)
    if (!isNaN(num) && num >= 1 && num <= list.length) {
      const selected = list[num - 1]
      return selected?.id
    }

    return undefined
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
      const rootScope: Scope = yield* discoverScopeTree(
        workspace,
        (children, body) => {
          const base = coderSystemPrompt(
            workspace,
            new Date(),
            skills,
            children,
            instructionFiles,
          )
          return body !== undefined && body.trim().length > 0
            ? `${base}\n\n# Project scope\n\n${body}`
            : base
        },
      )

      switch (chosen) {
        case "print":
          if (effectivePrompt === undefined) {
            yield* Effect.sync(() => {
              process.stderr.write(
                "agent: print mode needs a prompt (argv or stdin)\n",
              )
              process.exit(1)
            })
            return
          }
          yield* runPrintMode({
            prompt: effectivePrompt,
            cwd: workspace,
            skills,
            rootScope,
            allowBash: effectiveAllowBash,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          })
          return
        case "json":
          if (effectivePrompt === undefined) {
            yield* Effect.sync(() => {
              process.stderr.write(
                "agent: json mode needs a prompt (argv or stdin)\n",
              )
              process.exit(1)
            })
            return
          }
          yield* runJsonMode({
            prompt: effectivePrompt,
            cwd: workspace,
            skills,
            rootScope,
            allowBash: effectiveAllowBash,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          })
          return
        case "rpc":
          yield* runRpcMode({
            cwd: workspace,
            skills,
            rootScope,
            allowBash: effectiveAllowBash,
          })
          return
        case "tui": {
          let tuiResumeId: string | undefined = resumeId
          if (tuiResumeId === undefined && process.stdin.isTTY) {
            const store = yield* ConversationStore
            const list = yield* store.listByWorkspace(workspace).pipe(
              Effect.catchAll(() => Effect.succeed([])),
            )
            if (list.length > 0) {
              tuiResumeId = yield* promptConversationSelection(list)
            }
          }
          yield* runTuiMode({
            cwd: workspace,
            skills,
            rootScope,
            instructionFiles,
            ...(tuiResumeId !== undefined ? { resumeConversationId: tuiResumeId } : {}),
          })
          return
        }
      }
    }).pipe(Effect.provide(AppLive)),
)

/* ------------------------------------------------------------------ */
/* `efferent init` — set up the global ~/.efferent config              */
/* ------------------------------------------------------------------ */

const initProvider = Options.choice("provider", ["google", "openai"]).pipe(
  Options.withDefault("google" as const),
  Options.withDescription("Which provider the --key belongs to."),
)
const initKey = Options.text("key").pipe(
  Options.optional,
  Options.withDescription("API key to store in ~/.efferent/auth.json."),
)
const initModel = Options.text("model").pipe(
  Options.optional,
  Options.withDescription(
    "Default model to pin in ~/.efferent/config.json (e.g. google:gemini-3.5-flash).",
  ),
)

const initCommand = Command.make(
  "init",
  { provider: initProvider, key: initKey, model: initModel },
  ({ provider, key, model }) =>
    Effect.sync(() => {
      const dir = join(homedir(), ".efferent")
      mkdirSync(dir, { recursive: true })

      // API keys live in auth.json (separate from config.json so a `/model`
      // switch, which rewrites config.json, never clobbers them).
      if (key._tag === "Some") {
        const authPath = join(dir, "auth.json")
        let auth: Record<string, string> = {}
        if (existsSync(authPath)) {
          try {
            auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, string>
          } catch {
            /* overwrite malformed auth */
          }
        }
        auth[provider] = key.value
        writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`)
      }

      if (model._tag === "Some") {
        const cfgPath = join(dir, "config.json")
        let cfg: Record<string, unknown> = {}
        if (existsSync(cfgPath)) {
          try {
            cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>
          } catch {
            /* overwrite malformed config */
          }
        }
        cfg.model = model.value
        writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
      }

      const envName =
        provider === "google" ? "GOOGLE_GENERATIVE_AI_API_KEY" : "OPENAI_API_KEY"
      console.log(`efferent: global config at ${dir}`)
      console.log(
        `  history → ${join(dir, "efferent.db")} (SQLite; set EFFERENT_DB_URL for Postgres)`,
      )
      console.log(
        key._tag === "Some"
          ? `  ${provider} key stored in auth.json`
          : `  no key stored — re-run with --key, or set ${envName} in your env`,
      )
      if (model._tag === "Some") console.log(`  default model → ${model.value}`)
      console.log(`\nRun \`efferent\` in any project to start.`)
    }),
).pipe(Command.withDescription("Set up the global ~/.efferent config (API key, default model)."))

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Seed provider keys from the global `~/.efferent/auth.json` into the env
 * *before* the layers build, so a global install works without exported env
 * vars. Real env vars (incl. a project `.env`) always win — this only fills
 * gaps.
 */
const seedKeysFromGlobalAuth = (): void => {
  try {
    const p = join(homedir(), ".efferent", "auth.json")
    if (!existsSync(p)) return
    const auth = JSON.parse(readFileSync(p, "utf8")) as {
      google?: string
      openai?: string
    }
    if (auth.google && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = auth.google
    }
    if (auth.openai && !process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = auth.openai
    }
  } catch {
    /* ignore malformed auth — env / explicit config still apply */
  }
}

seedKeysFromGlobalAuth()

const cli = Command.run(root.pipe(Command.withSubcommands([initCommand])), {
  name: "efferent",
  version: "0.0.0",
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
