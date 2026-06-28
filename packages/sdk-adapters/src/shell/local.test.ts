import { describe, expect, it } from "bun:test"
import {
  type AgentBgOutputEvent,
  RunContextRef,
  Shell,
  ShellTimeout,
} from "@xandreed/sdk-core"
import { Effect, Exit, Ref } from "effect"
import { LocalShellLive } from "./local.js"

const run = <A, E>(e: Effect.Effect<A, E, Shell>): Promise<A> =>
  Effect.runPromise(e.pipe(Effect.provide(LocalShellLive)))

const runExit = <A, E>(e: Effect.Effect<A, E, Shell>) =>
  Effect.runPromiseExit(e.pipe(Effect.provide(LocalShellLive)))

describe("LocalShell.exec — group-kill + no-hang-on-orphan", () => {
  it("runs a normal command and returns its output", async () => {
    const r = await run(
      Effect.gen(function* () {
        return yield* (yield* Shell).exec({ command: "echo hello", cwd: ".", timeoutMs: 5000 })
      }),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("hello")
    expect(r.timedOut).toBe(false)
  })

  it("times out FAST and group-kills a long command (does not hang)", async () => {
    const start = Date.now()
    const exit = await runExit(
      Effect.gen(function* () {
        return yield* (yield* Shell).exec({ command: "sleep 30", cwd: ".", timeoutMs: 300 })
      }),
    )
    const elapsed = Date.now() - start
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect(err).toBeInstanceOf(ShellTimeout)
    }
    // ~300ms timeout + 1s SIGKILL grace + 200ms drain — comfortably under the 30s sleep.
    expect(elapsed).toBeLessThan(3000)
  })

  // THE REGRESSION: the 41-minute hang. A command whose bash exits while a
  // disowned child still holds the stdout pipe must NOT keep the call alive.
  it("returns promptly when the command backgrounds a child that outlives bash", async () => {
    const start = Date.now()
    const r = await run(
      Effect.gen(function* () {
        // `sleep 2 &` inherits the stdout pipe and outlives the `echo`-then-exit bash.
        return yield* (yield* Shell).exec({
          command: "sleep 2 & echo started",
          cwd: ".",
          timeoutMs: 10_000,
        })
      }),
    )
    const elapsed = Date.now() - start
    expect(r.stdout).toContain("started")
    // Settles on bash's exit + the 200ms drain grace — NOT after the 2s child, and
    // nowhere near the 10s timeout. (Pre-fix this hung on readAll until the child died.)
    expect(elapsed).toBeLessThan(1500)
  })

  // Timeout independence (the user's constraint): exec honors whatever timeout it
  // is GIVEN — a long verifier-style cap and a short tool-style cap are independent.
  it("honors an explicit long timeout for a quick command (verifier path)", async () => {
    const r = await run(
      Effect.gen(function* () {
        return yield* (yield* Shell).exec({
          command: "echo ok",
          cwd: ".",
          timeoutMs: 1_800_000, // 30 min — the verifier's cap; the quick command returns at once
        })
      }),
    )
    expect(r.stdout.trim()).toBe("ok")
    expect(r.timedOut).toBe(false)
  })
})

describe("LocalShell background processes", () => {
  it("spawns, reads incremental output, and reports exit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const shell = yield* Shell
        const { id } = yield* shell.spawnBackground({
          command: "for i in 1 2 3; do echo line$i; sleep 0.05; done",
          cwd: ".",
        })
        // Poll until finished (bounded).
        let running = true
        let exitCode: number | null = null
        let stdout = ""
        for (let i = 0; i < 100 && running; i++) {
          yield* Effect.sleep("40 millis")
          const r = yield* shell.readBackground({ id })
          stdout += r.stdout
          running = r.running
          exitCode = r.exitCode
        }
        return { stdout, exitCode, running }
      }),
    )
    expect(out.running).toBe(false)
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain("line1")
    expect(out.stdout).toContain("line3")
  })

  it("kill_bash terminates a long-running background process", async () => {
    const out = await run(
      Effect.gen(function* () {
        const shell = yield* Shell
        const { id } = yield* shell.spawnBackground({ command: "sleep 30", cwd: "." })
        const before = yield* shell.readBackground({ id })
        const { killed } = yield* shell.killBackground(id)
        yield* Effect.sleep("1200 millis") // past the SIGKILL grace
        const after = yield* shell.readBackground({ id })
        return { runningBefore: before.running, killed, runningAfter: after.running }
      }),
    )
    expect(out.runningBefore).toBe(true)
    expect(out.killed).toBe(true)
    expect(out.runningAfter).toBe(false)
  })

  it("reading an unknown process id fails with ShellProcessNotFound", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        return yield* (yield* Shell).readBackground({ id: "bg_does_not_exist" })
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("emits bg_output via RunContext.onBgOutput as the process produces output", async () => {
    const chunks = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<AgentBgOutputEvent>>([])
        const shell = yield* Shell
        yield* Effect.gen(function* () {
          const { id } = yield* shell.spawnBackground({ command: "echo alpha; echo beta", cwd: "." })
          // give the drain handlers time to fire
          for (let i = 0; i < 50; i++) {
            const r = yield* shell.readBackground({ id })
            if (!r.running) break
            yield* Effect.sleep("30 millis")
          }
          yield* Effect.sleep("100 millis")
        }).pipe(
          Effect.locally(RunContextRef, {
            rootConversationId: null,
            parentNodeId: null,
            depth: 0,
            tokenPool: null,
            onBgOutput: (e: AgentBgOutputEvent) => Ref.update(seen, (xs) => [...xs, e]),
          }),
        )
        return yield* Ref.get(seen)
      }).pipe(Effect.provide(LocalShellLive)),
    )
    const text = chunks.map((c) => c.chunk).join("")
    expect(text).toContain("alpha")
    expect(text).toContain("beta")
    expect(chunks.every((c) => c.stream === "stdout")).toBe(true)
  })
})
