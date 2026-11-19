import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { Effect, Exit } from "effect"
import type { Layer } from "effect"
import { quoted } from "./host-command.entity.functions.js"
import { hostShell, runWhole } from "./host-shell.adapter.js"
import type { WholeOptions } from "./host-shell.adapter.js"
import type { HostShell } from "./host-shell.port.js"

const shell = (outputBytes?: number): Layer.Layer<HostShell> =>
  hostShell({ cwd: tmpdir(), env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, ...(outputBytes === undefined ? {} : { outputBytes }) })

const run = (args: ReadonlyArray<string>, options: WholeOptions = {}, outputBytes?: number) =>
  Effect.runPromiseExit(runWhole(args, options).pipe(Effect.provide(shell(outputBytes))))

describe("quoted", () => {
  test.each([
    ["plain", "plain"],
    ["a/b-c_d.ts", "a/b-c_d.ts"],
    ["two words", "'two words'"],
    ["it's", "'it'\\''s'"],
    ["", "''"],
  ])("%s", (argument, expected) => {
    expect(quoted(argument)).toBe(expected)
  })
})

describe("runWhole", () => {
  test("an argument with a space, a quote, $( and a backtick reaches the command as written", async () => {
    const argument = "a path/with 'quotes' \"and\" $(echo no) `echo no`; rm -rf nothing"
    const exit = await run(["printf", "%s", argument])
    expect(exit).toEqual(Exit.succeed({ stdout: argument, stderr: "", code: 0 }))
  })

  test("an output longer than a model's shell keeps (8 KiB) is read whole", async () => {
    const exit = await run(["sh", "-c", "head -c 20000 /dev/zero | tr '\\0' a"])
    expect(Exit.isSuccess(exit) && exit.value.stdout.length).toBe(20_000)
  })

  test("an output the shell cut fails with OutputCut, never parsed", async () => {
    const exit = await run(["sh", "-c", "head -c 9000 /dev/zero | tr '\\0' a"], {}, 1024)
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("OutputCut")
    const failure = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(failure?._tag === "Fail" && failure.error._tag === "OutputCut" && failure.error.cut).toBe(9000 - 1024)
  })

  test("an exit code not allowed fails with CommandFailed and the end of stderr; an allowed one is a result", async () => {
    const failed = await run(["sh", "-c", "echo nope >&2; exit 3"])
    const reason = Exit.isFailure(failed) ? failed.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag === "CommandFailed" && [reason.error.reason, reason.error.message]).toEqual(["exited", "exited with 3: nope"])
    expect(await run(["sh", "-c", "exit 3"], { exits: [0, 3] })).toEqual(Exit.succeed({ stdout: "", stderr: "", code: 3 }))
  })

  test("a command past its time fails with CommandFailed, timed out", async () => {
    const exit = await run(["sleep", "5"], { timeoutMs: 50 })
    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag === "CommandFailed" && reason.error.reason).toBe("timed-out")
  })
})
