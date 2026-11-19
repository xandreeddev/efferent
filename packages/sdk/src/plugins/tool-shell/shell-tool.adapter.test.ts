import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Tool } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core"
import type { Message } from "@xandreed/core"
import { callTool, inProcessJournal, scriptedShell, sessions, ShellRefused } from "../../index.js"
import type { RunRequest, ScriptedRun } from "../../index.js"
import { RunCommand, shellHandlers, shellTools } from "./shell-tool.adapter.js"

/** One turn that makes each call in order over a scripted shell: what each call stored, and what the shell was asked. */
const calls = (made: ReadonlyArray<unknown>, script: ReadonlyArray<ScriptedRun>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { shell, runs } = yield* scriptedShell(script)
    return yield* Effect.gen(function* () {
      const all = yield* Sessions
      const session = yield* all.open(yield* all.create({ owner: "test" }))
      yield* session.append(userMessage("go"))
      const toolkit = yield* shellTools
      const stored = yield* Effect.forEach(made, (params, index) =>
        Effect.map(callTool(toolkit, { id: `c${index}`, name: "runCommand", params }, session), (record) => record.message), { concurrency: 1 })
      return { stored: stored.map(resultOf), asked: yield* runs }
    }).pipe(Effect.provide(Layer.mergeAll(shellHandlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))).pipe(Layer.provideMerge(shell))))
  })))

const resultOf = (message: Message | undefined) => (message?._tag === "ToolResult" ? [message.result, message.isFailure] : message)

describe("runCommand", () => {
  test("says what it runs, with whose rights, what it returns and when it stops a command, in fixed words", () => {
    expect(RunCommand.name).toBe("runCommand")
    expect(RunCommand.description).toBe(
      "Run a command in a shell (sh -c) on the host's machine, with the host's rights, starting in the host's folder; it reads no input. Returns how it `ended` (\"exited\", \"timed out\" or \"killed\"), its `exitCode` when it exited, and the end of its `stdout` and `stderr`: when either is longer than the shell keeps, `stdoutCut` or `stderrCut` counts the bytes left out before it. A command still running after `timeoutSeconds` is stopped, with every process it started; so is anything it leaves running in the background when it returns.",
    )
    expect(Tool.getJsonSchema(RunCommand)).toEqual({
      type: "object",
      properties: {
        command: { type: "string", description: "The command, as you would type it in a terminal, such as ls -la or npm test." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "How long the command may run, in seconds, at most 600. Left out, the host's default." },
      },
      required: ["command"],
      additionalProperties: true,
    })
  })

  test("each way a command ends is a result the model reads, with its output; the timeout is passed in milliseconds", async () => {
    const { stored, asked } = await calls(
      [{ command: "ls" }, { command: "false" }, { command: "sleep 99", timeoutSeconds: 2 }, { command: "kill -9 $$" }],
      [
        { stdout: "a.txt\n", stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "Exited", code: 0 } },
        { stdout: "", stderr: "failed\n", stdoutCut: 0, stderrCut: 12, ended: { _tag: "Exited", code: 1 } },
        { stdout: "", stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "TimedOut", afterMs: 2000 } },
        { stdout: "", stderr: "", stdoutCut: 0, stderrCut: 0, ended: { _tag: "Killed", signal: "SIGKILL" } },
      ],
    )
    expect(stored).toEqual([
      [{ ended: "exited", exitCode: 0, stdout: "a.txt\n", stderr: "", stdoutCut: 0, stderrCut: 0 }, false],
      [{ ended: "exited", exitCode: 1, stdout: "", stderr: "failed\n", stdoutCut: 0, stderrCut: 12 }, false],
      [{ ended: "timed out", stdout: "", stderr: "", stdoutCut: 0, stderrCut: 0 }, false],
      [{ ended: "killed", stdout: "", stderr: "", stdoutCut: 0, stderrCut: 0 }, false],
    ])
    expect(asked).toEqual<ReadonlyArray<RunRequest>>([{ command: "ls" }, { command: "false" }, { command: "sleep 99", timeoutMs: 2000 }, { command: "kill -9 $$" }])
  })

  test("a command the shell declines, and an empty one, are failed results in fixed words; the empty one is never run", async () => {
    const { stored, asked } = await calls(
      [{ command: "  " }, { command: "rm -rf build" }],
      [new ShellRefused({ reason: "commands that remove files are kept from the agent", message: "declined" })],
    )
    expect(stored).toEqual([
      ["The command is empty: give the command to run, such as ls -la.", true],
      ["The shell declined this command: \"commands that remove files are kept from the agent\". Do not run it again unless the user asks for it.", true],
    ])
    expect(asked).toEqual([{ command: "rm -rf build" }])
  })

  test("a shell that cannot run anything is a defect, stored as a failed result; a timeout over the limit is refused by the schema", async () => {
    const { stored, asked } = await calls([{ command: "ls" }, { command: "ls", timeoutSeconds: 601 }], [])
    expect(stored.map((one) => Array.isArray(one) ? one[1] : one)).toEqual([true, true])
    // The scripted shell has no run left: the first call met ShellUnavailable; the second never reached the shell.
    expect(asked).toEqual([{ command: "ls" }])
  })
})
