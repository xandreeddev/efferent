import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { MAX_OUTPUT_BYTES, spawnBounded } from "./spawn.js"

const exec = (command: string, timeoutMs = 10_000) =>
  Effect.runPromise(spawnBounded(["bash", "-c", command], undefined, timeoutMs))

describe("spawnBounded", () => {
  test("a normal command round-trips stdout/stderr/exit", async () => {
    const result = await exec(`echo out; echo err >&2; exit 3`)
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.exitCode).toBe(3)
  })

  test("the timeout kills the WHOLE process group — a background child dies too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-group-"))
    const pidFile = join(dir, "pid")
    // The naive kill left this sleeper running (it reparents to init when
    // bash dies); the group kill must take it down.
    const result = await exec(`sleep 300 & echo $! > ${pidFile}; wait`, 300)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("timed out")
    const sleeperPid = Number(readFileSync(pidFile, "utf-8").trim())
    const alive = Effect.runSync(
      Effect.try(() => {
        process.kill(sleeperPid, 0)
        return true
      }).pipe(Effect.orElseSucceed(() => false)),
    )
    expect(alive).toBe(false)
  })

  test("output past the cap is clipped with a note; the command still COMPLETES", async () => {
    // ~4MB of output, far past the cap — the drain must keep the pipe from
    // blocking so the command exits 0 on its own.
    const result = await exec(`yes x | head -c 4194304; echo DONE-MARKER >&2`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeLessThan(MAX_OUTPUT_BYTES + 200)
    expect(result.stdout).toContain("output truncated")
    expect(result.stderr).toContain("DONE-MARKER")
  })

  test("a missing binary is a non-zero RESULT carrying the loader's message (failure-as-data)", async () => {
    // Under the setsid wrapper the spawn itself succeeds and setsid reports
    // the exec failure — the model reads WHY instead of an infra error.
    const result = await Effect.runPromise(
      spawnBounded(["this-binary-does-not-exist-xyz"], undefined, 1_000),
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("this-binary-does-not-exist-xyz")
  })
})
