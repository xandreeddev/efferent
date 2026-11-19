import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { Effect } from "effect"
import { UsageError } from "./cli.entity.js"
import { runMain } from "./run-main.adapter.js"
import type { CliProcess } from "./run-main.adapter.js"

/** A process stand-in: signals are emitted by the test, the exit code resolves `exited`. */
const fakeProcess = () => {
  const signals = new EventEmitter()
  const errors: Array<string> = []
  const exited = Promise.withResolvers<number>()
  const host: CliProcess = {
    once: (signal, listener) => signals.once(signal, listener),
    off: (signal, listener) => signals.off(signal, listener),
    setExitCode: (code) => exited.resolve(code),
    printError: (line) => {
      errors.push(line)
    },
  }
  return { signals, errors, exited: exited.promise, host }
}

test("a signal interrupts the command: its finalizers run (a worktree is removed), its listeners go and it exits 130", async () => {
  const { signals, exited, host } = fakeProcess()
  const started = Promise.withResolvers<void>()
  const released: Array<string> = []
  runMain(
    Effect.acquireRelease(Effect.sync(() => started.resolve()), () => Effect.sync(() => {
      released.push("worktree")
    })).pipe(Effect.andThen(Effect.never), Effect.scoped),
    host,
  )
  await started.promise
  signals.emit("SIGINT")
  expect(await exited).toBe(130)
  expect(released).toEqual(["worktree"])
  expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0)
})

test("the command's own exit code is kept, and a typed failure prints <tag>: <message> and exits 1", async () => {
  const done = fakeProcess()
  runMain(Effect.succeed(0), done.host)
  expect(await done.exited).toBe(0)
  const failed = fakeProcess()
  runMain(Effect.fail(new UsageError({ message: "--repo needs a value" })), failed.host)
  expect(await failed.exited).toBe(1)
  expect(failed.errors).toEqual(["UsageError: --repo needs a value"])
})

test("the bin runs on Node 24 through tsx: a usage error is printed and exits 1", () => {
  const ran = Bun.spawnSync(["node", join(import.meta.dir, "..", "bin", "efferent-review.mjs"), "prepare"], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } })
  expect(ran.exitCode).toBe(1)
  expect(ran.stderr.toString().split("\n")[0]).toBe("UsageError: efferent-review takes the command prepare or review and a pull request's number")
})
