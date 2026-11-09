import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Fiber, Option, Result } from "effect"
import { AttemptNumber, WorkspacePath } from "../domain/Brands.js"
import { ForgeLimits, Spec } from "../domain/Spec.js"
import { implementCommand, implementationPrompt } from "./claudeImplementor.js"

const spec = new Spec({ goal: "Add a reader", acceptance: ["reads bounded input"], limits: new ForgeLimits({ maxAttempts: 1, budgetMillis: 1000 }) })

test("implementation prompt includes the exact goal, acceptance and previous feedback", () => {
  expect(implementationPrompt(spec, Option.some("use the port"))).toBe("Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.\n\n## Goal\nAdd a reader\n\n## Acceptance\n- reads bounded input\n\n## Previous attempt was rejected\nuse the port")
  expect(implementationPrompt(spec, Option.none())).toBe("Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.\n\n## Goal\nAdd a reader\n\n## Acceptance\n- reads bounded input")
})

test("interrupting an implementor kills and reaps its child before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-implementor-"))
  await (async () => {
    const input = { spec, feedback: Option.none<string>(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(directory) }
    const command = [process.execPath, "-e", 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000)']
    const pid = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* Effect.forkScoped(implementCommand(input, command))
      const wait: Effect.Effect<number, Error> = Effect.tryPromise(() => readFile(join(directory, "child.pid"), "utf8")).pipe(Effect.map(Number), Effect.catch(() => Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(() => wait)))))
      const pid = yield* wait.pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(child)
      return pid
    })))
    expect(() => process.kill(pid, 0)).toThrow()
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 10_000)

/** Whether `pid` is gone within `ms` (an orphan may stay a zombie until its new parent reaps it). */
const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
  const alive = () => { const probe = Result.try(() => process.kill(pid, 0)); return Result.isSuccess(probe) }
  const deadline = Date.now() + ms
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  return !alive()
}

test("interrupting an implementor stops the processes it started too, after a grace period to stop them itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-implementor-"))
  await (async () => {
    const input = { spec, feedback: Option.none<string>(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(directory) }
    // The implementor starts a long-lived tool process of its own, as claude's Bash tool does, and notes SIGTERM.
    const program = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      'const tool = spawn("sleep", ["30"], { stdio: "ignore" })',
      'process.on("SIGTERM", () => { writeFileSync("terminated", "yes"); process.exit(0) })',
      'writeFileSync("pids", JSON.stringify([process.pid, tool.pid]))',
      "setInterval(() => {}, 1000)",
    ].join("\n")
    const pids = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* Effect.forkScoped(implementCommand(input, [process.execPath, "-e", program]))
      const wait: Effect.Effect<ReadonlyArray<number>, Error> = Effect.tryPromise(() => readFile(join(directory, "pids"), "utf8")).pipe(
        Effect.map((text): ReadonlyArray<number> => text.split(/[^0-9]+/).filter((part) => part.length > 0).map(Number)),
        Effect.catch(() => Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(() => wait)))))
      const pids = yield* wait.pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(child)
      return pids
    })))
    expect(pids).toHaveLength(2)
    expect(await goneWithin(pids[0]!, 2000)).toBe(true)
    expect(await goneWithin(pids[1]!, 2000)).toBe(true)
    expect(await readFile(join(directory, "terminated"), "utf8")).toBe("yes")
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 15_000)

test.each(["interrupted", "exited"] as const)("a tool process still stopping when its implementor %s gets the grace period before SIGKILL", async (ending) => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-implementor-"))
  await (async () => {
    const input = { spec, feedback: Option.none<string>(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(directory) }
    // The tool process takes a moment to stop on SIGTERM; the implementor itself stops at once (or has already exited).
    const tool = [
      'const { writeFileSync } = require("node:fs")',
      'process.on("SIGTERM", () => setTimeout(() => { writeFileSync("tool-stopped", "yes"); process.exit(0) }, 300))',
      'writeFileSync("tool.pid", String(process.pid))',
      "setInterval(() => {}, 1000)",
    ].join("\n")
    const program = [
      'const { spawn } = require("node:child_process")',
      'const { existsSync } = require("node:fs")',
      `spawn(process.execPath, ["-e", ${JSON.stringify(tool)}], { stdio: "ignore" })`,
      ending === "exited"
        ? 'const ready = setInterval(() => { if (existsSync("tool.pid")) { clearInterval(ready); process.exit(0) } }, 10)'
        : "setInterval(() => {}, 1000)",
    ].join("\n")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* Effect.forkScoped(Effect.result(implementCommand(input, [process.execPath, "-e", program])))
      const wait: Effect.Effect<string, Error> = Effect.tryPromise(() => readFile(join(directory, "tool.pid"), "utf8")).pipe(
        Effect.catch(() => Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(() => wait)))))
      yield* wait.pipe(Effect.timeout("5 seconds"))
      yield* ending === "exited" ? Fiber.join(child).pipe(Effect.asVoid) : Fiber.interrupt(child).pipe(Effect.asVoid)
    })))
    const stopped = await readFile(join(directory, "tool-stopped"), "utf8").then((text) => text, () => "killed first")
    expect(stopped).toBe("yes")
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 15_000)

test("an implementor that exits nonzero fails with its code and what it wrote to stderr", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-implementor-"))
  await (async () => {
    const input = { spec, feedback: Option.none<string>(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(directory) }
    const failure = await Effect.runPromise(Effect.flip(implementCommand(input, [process.execPath, "-e", 'process.stderr.write("no credentials"); process.exit(3)'])))
    expect(failure.message).toBe("claude exited 3: no credentials")
    expect(await Effect.runPromise(implementCommand(input, [process.execPath, "-e", "process.exit(0)"]))).toEqual({ filesTouched: [] })
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 15_000)
