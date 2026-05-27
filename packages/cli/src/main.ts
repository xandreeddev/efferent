#!/usr/bin/env bun
import { homedir } from "node:os"
import { Args, Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { loadSkills } from "@agent/core"
import {
  DatabaseLive,
  GeminiFastLive,
  GeminiLive,
  LocalFileSystemLive,
  LocalShellLive,
  PostgresConversationStoreLive,
} from "@agent/adapters"

import { runPrintMode } from "./modes/print.js"
import { runJsonMode } from "./modes/json.js"
import { runRpcMode } from "./modes/rpc.js"
import { runTuiMode } from "./modes/tui.js"

/* ------------------------------------------------------------------ */
/* Composition root                                                    */
/* ------------------------------------------------------------------ */

const AppLive = Layer.mergeAll(
  PostgresConversationStoreLive.pipe(Layer.provide(DatabaseLive)),
  GeminiLive,
  GeminiFastLive,
  LocalFileSystemLive,
  LocalShellLive,
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

const root = Command.make(
  "agent",
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

      // Discover skills once at startup. `.agent/skills/*.md` walked from
      // cwd → parents → ~/.agent/skills. Closer-to-cwd shadows farther.
      // Failures fall back to an empty list — never breaks the agent.
      const skills = yield* loadSkills(workspace, homedir())

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
            allowBash,
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
            allowBash,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          })
          return
        case "rpc":
          yield* runRpcMode({ cwd: workspace, skills, allowBash })
          return
        case "tui":
          yield* runTuiMode({
            cwd: workspace,
            skills,
            ...(resumeId !== undefined ? { resumeConversationId: resumeId } : {}),
          })
          return
      }
    }).pipe(Effect.provide(AppLive)),
)

const cli = Command.run(root, {
  name: "agent",
  version: "0.0.0",
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
