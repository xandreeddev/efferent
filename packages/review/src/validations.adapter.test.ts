import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Option } from "effect"
import { Shell } from "@xandreed/sdk"
import { processShell } from "@xandreed/sdk/node"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import { allowOnly, processValidations } from "./validations.adapter.js"
import { Validations } from "./validations.port.js"

const root = mkdtempSync(join(tmpdir(), "review-validations-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const PATH = process.env["PATH"] ?? "/usr/bin:/bin"

describe("allowOnly", () => {
  test("runs a listed command as written and refuses any other with ShellRefused, running nothing", async () => {
    const shell = allowOnly(["echo listed"])(processShell({ cwd: root, env: { PATH } }))
    const [listed, other] = await Effect.runPromise(Effect.gen(function* () {
      const run = (yield* Shell).run
      return [yield* run({ command: "echo listed" }), yield* Effect.exit(run({ command: `echo listed; touch ${join(root, "ran")}` }))] as const
    }).pipe(Effect.provide(shell)))
    expect(listed.stdout).toBe("listed\n")
    const reason = Exit.isFailure(other) ? other.cause.reasons[0] : undefined
    expect(reason?._tag === "Fail" && reason.error._tag).toBe("ShellRefused")
    expect(existsSync(join(root, "ran"))).toBe(false)
  })
})

describe("processValidations", () => {
  test("runs each command in the worktree with PATH and a throwaway HOME alone, keeps each log whole and digests it", async () => {
    process.env["REVIEW_HOST_SECRET"] = "a value no command may see"
    const commands = ["env | sort; pwd", "echo 'error: broken' >&2; exit 2", "sleep 5"]
    const layer = processValidations({ path: PATH }).pipe(Layer.provide(directoryLogs(join(root, "logs"))))
    const digests = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* Validations).run({ commands, cwd: root, logFolder: "7-abc", changedPaths: [], limits: DIGEST_LIMITS, timeoutMs: 1_000 })
    }).pipe(Effect.provide(layer)))
    expect<unknown>(digests.map((digest) => [digest.source, digest.ended, Option.getOrNull(digest.exit), digest.logPath])).toEqual([
      [{ _tag: "Command", command: commands[0] }, "exited with 0", 0, join(root, "logs", "7-abc", "run-1.log")],
      [{ _tag: "Command", command: commands[1] }, "exited with 2", 2, join(root, "logs", "7-abc", "run-2.log")],
      [{ _tag: "Command", command: commands[2] }, "timed out after 1000 ms", null, join(root, "logs", "7-abc", "run-3.log")],
    ])
    const environment = readFileSync(join(root, "logs", "7-abc", "run-1.log"), "utf8")
    const names = environment.split("\n").flatMap((line) => (/^[A-Z_]+=/.test(line) ? [line.slice(0, line.indexOf("="))] : []))
    // `sh` adds its own PWD, SHLVL and `_`; nothing of the host's but PATH.
    expect(names.filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))).toEqual(["HOME", "PATH"])
    expect(environment).not.toContain("REVIEW_HOST_SECRET")
    const home = /^HOME=(.*)$/m.exec(environment)?.[1] ?? ""
    expect(home).toContain("efferent-review-home-")
    expect(existsSync(home)).toBe(false)
    expect(environment.trim().endsWith(root)).toBe(true)
    expect(digests[1]?.digest.lines).toEqual(["error: broken"])
    expect(readFileSync(join(root, "logs", "7-abc", "run-2.log"), "utf8")).toBe("\n--- stderr ---\nerror: broken\n")
    delete process.env["REVIEW_HOST_SECRET"]
  })
})
