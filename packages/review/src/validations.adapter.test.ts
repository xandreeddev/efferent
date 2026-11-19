import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Option } from "effect"
import { Shell } from "@xandreed/sdk"
import { processShell } from "@xandreed/sdk/node"
import type { ReviewLogs } from "./review-logs.port.js"
import { reviewLayers } from "./cli.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import { allowOnly, shellValidations } from "./validations.adapter.js"
import { Validations } from "./validations.port.js"

const root = mkdtempSync(join(tmpdir(), "review-validations-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const PATH = process.env["PATH"] ?? "/usr/bin:/bin"

/** A shell for these tests only: the host's processes. The command line never gives one, since it is no sandbox. */
const testShell = processShell({ cwd: root, env: { PATH } })

describe("allowOnly", () => {
  test("runs a listed command as written and refuses any other with ShellRefused, running nothing", async () => {
    const [listed, other] = await Effect.runPromise(Effect.gen(function* () {
      const shell = allowOnly(["echo listed"], yield* Shell)
      return [yield* shell.run({ command: "echo listed" }), yield* Effect.exit(shell.run({ command: `echo listed; touch ${join(root, "ran")}` }))] as const
    }).pipe(Effect.provide(testShell)))
    expect(listed.stdout).toBe("listed\n")
    const reason = Exit.isFailure(other) ? other.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag).toBe("ShellRefused")
    expect(existsSync(join(root, "ran"))).toBe(false)
  })
})

describe("shellValidations", () => {
  test("runs each command in the worktree through the shell the host gives, keeps each log whole and digests it", async () => {
    const commands = ["pwd", "echo 'error: broken' >&2; exit 2", "sleep 5"]
    const layer = shellValidations.pipe(Layer.provide(Layer.merge(directoryLogs(join(root, "logs")), testShell)))
    const digests = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* Validations).run({ commands, cwd: root, logFolder: "7-abc", changedPaths: [], limits: DIGEST_LIMITS, timeoutMs: 1_000 })
    }).pipe(Effect.provide(layer)))
    expect<unknown>(digests.map((digest) => [digest.source, digest.ended, Option.getOrNull(digest.exit), digest.logPath])).toEqual([
      [{ _tag: "Command", command: commands[0] }, "exited with 0", 0, join(root, "logs", "7-abc", "run-1.log")],
      [{ _tag: "Command", command: commands[1] }, "exited with 2", 2, join(root, "logs", "7-abc", "run-2.log")],
      [{ _tag: "Command", command: commands[2] }, "timed out after 1000 ms", null, join(root, "logs", "7-abc", "run-3.log")],
    ])
    expect(readFileSync(join(root, "logs", "7-abc", "run-1.log"), "utf8")).toBe(`${root}\n`)
    expect(digests[1]?.digest.lines).toEqual(["error: broken"])
    expect(readFileSync(join(root, "logs", "7-abc", "run-2.log"), "utf8")).toBe("\n--- stderr ---\nerror: broken\n")
  })

  test("type-level: the stock validations need a Shell the host gives; the command line's layers give neither a Shell nor Validations", () => {
    type Needs<L> = L extends Layer.Layer<infer _Out, infer _Error, infer In> ? In : never
    type Gives<L> = L extends Layer.Layer<infer Out, infer _Error, infer _In> ? Out : never
    const needsShell: [Shell] extends [Needs<typeof shellValidations>] ? true : false = true
    const needsLogs: [ReviewLogs] extends [Needs<typeof shellValidations>] ? true : false = true
    type CliGives = Gives<ReturnType<typeof reviewLayers>>
    const noShell: [Shell] extends [CliGives] ? false : true = true
    const noValidations: [Validations] extends [CliGives] ? false : true = true
    expect([needsShell, needsLogs, noShell, noValidations]).toEqual([true, true, true, true])
  })
})
