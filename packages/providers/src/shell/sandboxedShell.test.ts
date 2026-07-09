import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Shell } from "@xandreed/engine"
import { bwrapArgs, SandboxedShellLive } from "./sandboxedShell.js"

// `command -v` returns non-zero when bwrap is absent — never throws (a bare
// spawn of a missing executable would). CI has no bwrap; these tests skip.
const hasBwrap = Bun.spawnSync(["bash", "-c", "command -v bwrap"]).exitCode === 0

describe("bwrapArgs", () => {
  test("binds the workspace rw, root ro, fresh /tmp + HOME, dies with parent", () => {
    const args = bwrapArgs("/ws", "/ws/sub", "echo hi")
    expect(args[0]).toBe("bwrap")
    expect(args).toContain("--die-with-parent")
    // workspace bound read-write; root read-only.
    expect(args.join(" ")).toContain("--bind /ws /ws")
    expect(args.join(" ")).toContain("--ro-bind / /")
    expect(args.join(" ")).toContain("--tmpfs /tmp")
    expect(args.join(" ")).toContain("--chdir /ws/sub")
    // HOME redirected into the throwaway tmpfs.
    expect(args.join(" ")).toContain("--setenv HOME /tmp/home")
    expect(args.slice(-3)).toEqual(["bash", "-c", "echo hi"])
  })
})

describe.if(hasBwrap)("SandboxedShellLive (live — bwrap present)", () => {
  const runIn = <A, E>(cwd: string, effect: Effect.Effect<A, E, Shell>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(SandboxedShellLive(cwd))) as Effect.Effect<A, E>)

  test("writes INSIDE the workspace succeed; writes OUTSIDE fail", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"))
    const outside = mkdtempSync(join(tmpdir(), "sbx-out-"))
    const result = await runIn(
      ws,
      Effect.gen(function* () {
        const shell = yield* Shell
        const inside = yield* shell.exec("echo hello > allowed.txt && cat allowed.txt")
        const escape = yield* shell.exec(`echo pwned > ${join(outside, "escape.txt")}`)
        return { inside, escape }
      }),
    )
    // Inside the workspace: written and readable (the bind is rw).
    expect(result.inside.exitCode).toBe(0)
    expect(result.inside.stdout.trim()).toBe("hello")
    expect(readFileSync(join(ws, "allowed.txt"), "utf-8").trim()).toBe("hello")
    // Outside: the read-only root rejects the write (non-zero exit, no file).
    expect(result.escape.exitCode).not.toBe(0)
    expect(() => readFileSync(join(outside, "escape.txt"))).toThrow()
  })

  test("a non-zero exit is a RESULT, not an error (the Shell contract holds)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"))
    const result = await runIn(
      ws,
      Effect.flatMap(Shell, (shell) => shell.exec("exit 3")),
    )
    expect(result.exitCode).toBe(3)
  })
})
