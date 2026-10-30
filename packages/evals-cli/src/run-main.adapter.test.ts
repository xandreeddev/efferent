import { EvaluationError, TranscriptEvent, Trial } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schedule, Schema } from "effect"
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

/**
 * The hanging run on Node (its configuration loader is tsx's, with tsx
 * resolving the sources) in a fresh directory, once its trial has stored
 * both its events. `read` gives a trial file's text by its suffix, "" when
 * there is none.
 */
const hangingRun = async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-signal-"))
  const child = Bun.spawn(
    ["node", "--import", import.meta.resolve("tsx/esm"), join(import.meta.dir, "main.ts"), "run", "suite",
      "--config", join(import.meta.dir, "hanging-run.testing.ts"), "--directory", directory],
    { stdout: "ignore", stderr: "ignore" }
  )
  const trials = join(directory, "trials")
  const read = (suffix: string) => Effect.tryPromise(async () => {
    const name = (await readdir(trials)).find((entry) => entry.endsWith(suffix))
    return name === undefined ? "" : await readFile(join(trials, name), "utf8")
  })
  await Effect.runPromise(read(".events.jsonl").pipe(
    Effect.filterOrFail((text) => text.split("\n").length === 3),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("20 seconds")
  ))
  return { child, read: (suffix: string) => Effect.runPromise(read(suffix)) }
}
const trialOf = Schema.decodeUnknownSync(Schema.fromJsonString(Trial))
const eventOf = Schema.decodeUnknownSync(Schema.fromJsonString(TranscriptEvent))
const eventsOf = (text: string) => text.trimEnd().split("\n").map((line) => eventOf(line))

test("Ctrl-C during a run settles its trial as cancelled on disk, with its events, and exits 130", async () => {
  const { child, read } = await hangingRun()
  child.kill("SIGINT")
  expect(await child.exited).toBe(130)
  expect(child.signalCode).toBeNull()
  const settled = trialOf(await read(".json"))
  expect([settled.status, settled.reason]).toEqual(["cancelled", "interrupted"])
  expect(settled.transcript.map((event) => event.kind)).toEqual(["tool.started", "tool.completed"])
  // The settled trial holds the events, so their file is gone.
  expect(await read(".events.jsonl")).toBe("")
}, 30_000)

test("a run killed mid-trial leaves the trial's events on disk, one JSON line each, beside the running trial", async () => {
  const { child, read } = await hangingRun()
  child.kill("SIGKILL")
  await child.exited
  expect(child.signalCode).toBe("SIGKILL")
  const events = eventsOf(await read(".events.jsonl"))
  expect(events.map((event) => [event.sequence, event.kind, event.data])).toEqual([
    [0, "tool.started", { tool: "lookup" }],
    [1, "tool.completed", { tool: "lookup", result: "found" }]
  ])
  const running = trialOf(await read(".json"))
  expect([running.status, running.transcript]).toEqual(["running", []])
  expect(events.map((event): string => event.id)).toEqual([`${running.id}/event/0`, `${running.id}/event/1`])
}, 30_000)
