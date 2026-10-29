import { EvaluationError } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Predicate, Schedule } from "effect"
import { runCliMain, type CliProcess } from "./run-main.adapter.js"

/** A process stand-in: signals are emitted by the test, the exit code resolves `exited`. */
const fakeProcess = () => {
  const signals = new EventEmitter()
  const errors: string[] = []
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

test("a signal interrupts the command: its finalizers run, its listeners go and it exits 130", async () => {
  const { signals, exited, host } = fakeProcess()
  const started = Promise.withResolvers<void>()
  const released: string[] = []
  runCliMain(
    Effect.acquireRelease(Effect.sync(() => started.resolve()), () => Effect.sync(() => {
      released.push("world")
    })).pipe(Effect.andThen(Effect.never), Effect.scoped),
    host
  )
  await started.promise
  signals.emit("SIGTERM")
  expect(await exited).toBe(130)
  expect(released).toEqual(["world"])
  expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0)
})

test("the command's own exit code is kept, and a typed failure prints code: message and exits 1", async () => {
  const gated = fakeProcess()
  runCliMain(Effect.succeed(2), gated.host)
  expect(await gated.exited).toBe(2)
  const failed = fakeProcess()
  runCliMain(Effect.fail(new EvaluationError({ code: "invalid", message: "Unknown command x" })), failed.host)
  expect(await failed.exited).toBe(1)
  expect(failed.errors).toEqual(["invalid: Unknown command x"])
})

// The command line runs on Node (its configuration loader is tsx's), with tsx resolving the sources.
test("Ctrl-C during a run settles its trial as cancelled on disk and exits 130", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-signal-"))
  const child = Bun.spawn(
    ["node", "--import", import.meta.resolve("tsx/esm"), join(import.meta.dir, "main.ts"), "run", "suite",
      "--config", join(import.meta.dir, "hanging-run.testing.ts"), "--directory", directory],
    { stdout: "ignore", stderr: "ignore" }
  )
  const trial = Effect.tryPromise(async () => {
    const names = await readdir(join(directory, "trials"))
    return JSON.parse(await readFile(join(directory, "trials", names[0]!), "utf8")) as unknown
  })
  const status = (value: unknown) => Predicate.hasProperty(value, "status") ? value.status : undefined
  await Effect.runPromise(trial.pipe(
    Effect.filterOrFail((value) => status(value) === "running"),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("20 seconds")
  ))
  child.kill("SIGINT")
  expect(await child.exited).toBe(130)
  expect(child.signalCode).toBeNull()
  const settled = await Effect.runPromise(trial)
  expect([status(settled), Predicate.hasProperty(settled, "reason") ? settled.reason : undefined]).toEqual(["cancelled", "interrupted"])
}, 30_000)
