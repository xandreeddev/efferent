import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { Array as Arr, Context, Deferred, Effect, Layer, Order } from "effect"
import type { ConformanceCheck } from "@xandreed/core"
import { Shell, shellConformance } from "../../index.js"
import type { Ran, ShellSubject } from "../../index.js"
import { scratch } from "../testing.js"
import { processShell } from "./process-shell.adapter.js"
import { tailOf } from "./process-shell.entity.functions.js"

/*
 * The shell kit's own test: it has the checks its doc comment lists, and each
 * careless shell written here fails the checks of what it is careless about and
 * no others, and between them every check. A careless shell that leaves a
 * process running stops it when its scope closes, so the test leaves none.
 */

type ShellShape = Context.Service.Shape<typeof Shell>

const ENV = { KIT_GIVEN: "given value", PATH: "/usr/bin:/bin" }
const OUTPUT_BYTES = 1000
const IDS = ["exit", "output", "bounded", "cwd", "environment", "timeout", "timeout-kills", "return-kills", "interrupt-kills", "close-kills"]

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => result._tag === "Failure" ? [result.failure.check === check.id ? check.id : `${check.id} reported as ${result.failure.check}`] : [])), { concurrency: 1 }))
    .then((failed) => Arr.sort(failed.flat(), Order.String))

/** The stock shell over `folder`, with the options a careless one changes. */
const stock = (folder: string, options: { readonly env?: Readonly<Record<string, string>>; readonly outputBytes?: number } = {}) =>
  Effect.map(Effect.orDie(Layer.build(processShell({ cwd: folder, env: options.env ?? ENV, outputBytes: options.outputBytes ?? OUTPUT_BYTES }))), (services) => Context.get(services, Shell))

/** The stock shell with its run changed, given the one it changes. */
const changed = (folder: string, change: (inner: ShellShape) => ShellShape["run"], options: { readonly env?: Readonly<Record<string, string>>; readonly outputBytes?: number } = {}) =>
  Effect.map(stock(folder, options), (inner) => Shell.of({ run: change(inner) }))

/** Stop a process, or with `whole` its group; one already gone is nothing to stop. */
const stop = (child: ChildProcess, whole: boolean) => {
  const pid = child.pid
  if (pid !== undefined) Effect.runSync(Effect.ignore(Effect.try(() => process.kill(whole ? -pid : pid, "SIGKILL")), { log: "Debug", message: "nothing left to stop" }))
}

/**
 * A shell that stops the command's whole group on every way a run ends but one, where it stops the shell's process
 * alone (or, once the command returned or the shell's scope closed, nothing): a shell written without a process
 * group in mind. Every command it
 * starts is put in `started`, which the test stops when it ends, so nothing outlives it.
 */
const leaky = (folder: string, careless: "timeout" | "return" | "interrupt" | "close", started: Set<ChildProcess>) => Effect.gen(function* () {
  const mine = new Set<ChildProcess>()
  // Careless about its close, it stops nothing then, and its commands run on.
  yield* Effect.addFinalizer(() => Effect.sync(() => { if (careless !== "close") mine.forEach((child) => stop(child, true)) }))
  return Shell.of({
    run: (request) => Effect.acquireUseRelease(
      Effect.sync(() => {
        const child = spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd ?? folder, env: ENV, detached: true, stdio: ["ignore", "pipe", "pipe"] })
        mine.add(child)
        started.add(child)
        return child
      }),
      (child) => Effect.gen(function* () {
        const exited = yield* Deferred.make<{ readonly code: number | null; readonly signal: string | null }>()
        const out: Array<Uint8Array> = []
        const err: Array<Uint8Array> = []
        child.stdout?.on("data", (chunk: Uint8Array) => { out.push(chunk) })
        child.stderr?.on("data", (chunk: Uint8Array) => { err.push(chunk) })
        child.once("exit", (code, signal) => Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })))
        const timeoutMs = request.timeoutMs ?? 120_000
        const inTime = yield* Effect.timeoutOption(Deferred.await(exited), timeoutMs)
        if (inTime._tag === "None") stop(child, careless !== "timeout")
        const exit = yield* Deferred.await(exited)
        if (inTime._tag === "Some" && careless !== "return") stop(child, true)
        // What is left of the output, read for a moment: a leaked process may hold the pipes.
        yield* Effect.sleep("50 millis")
        const stdout = tailOf(out, OUTPUT_BYTES)
        const stderr = tailOf(err, OUTPUT_BYTES)
        const ran: Ran = {
          stdout: stdout.text, stderr: stderr.text, stdoutCut: stdout.cut, stderrCut: stderr.cut,
          ended: inTime._tag === "None" ? { _tag: "TimedOut", afterMs: timeoutMs } : exit.signal !== null ? { _tag: "Killed", signal: exit.signal } : { _tag: "Exited", code: exit.code ?? 0 },
        }
        return ran
      }),
      (child, exit) => Effect.sync(() => {
        if (exit._tag === "Failure") stop(child, careless !== "interrupt")
        mine.delete(child)
      }),
    ),
  })
})

describe("the shell kit", () => {
  const folder = Effect.flatMap(scratch, (made) => Effect.promise(() => realpath(made)))
  const subjectOf = (at: string, open: ShellSubject["open"]): ShellSubject => ({ open, folder: at, env: ENV, outputBytes: OUTPUT_BYTES })

  test("has the checks its doc comment lists", async () => {
    const at = "/"
    expect(shellConformance(subjectOf(at, stock(at))).map((check) => check.id)).toEqual(IDS)
  })

  test("each careless shell fails the check of what it is careless about, and between them every check", async () => {
    const failed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* folder
      // Whatever a careless shell left running is stopped when the test ends.
      const started = new Set<ChildProcess>()
      yield* Effect.addFinalizer(() => Effect.sync(() => started.forEach((child) => stop(child, true))))
      /** The kit over a shell, in a folder of its own: kits run at once here, and each writes its files in its folder. */
      const kit = (name: string, open: (at: string) => ShellSubject["open"]) => Effect.gen(function* () {
        const at = join(root, name)
        yield* Effect.promise(() => mkdir(join(at, "elsewhere"), { recursive: true }))
        return yield* Effect.promise(() => failedChecks(shellConformance(subjectOf(at, open(at)))))
      })
      const all = yield* Effect.all({
        // It answers every exit as a success.
        zeroed: kit("zeroed", (at) => changed(at, (inner) => (request) => Effect.map(inner.run(request), (ran): Ran => ran.ended._tag === "Exited" ? { ...ran, ended: { _tag: "Exited", code: 0 } } : ran))),
        // It gives stderr as stdout.
        merged: kit("merged", (at) => changed(at, (inner) => (request) => Effect.map(inner.run(request), (ran): Ran => ({ ...ran, stdout: ran.stdout + ran.stderr, stderr: "" })))),
        // It keeps far more than it says.
        unbounded: kit("unbounded", (at) => changed(at, (inner) => inner.run, { outputBytes: 100 * OUTPUT_BYTES })),
        // It starts every command in a folder of its own.
        homebound: kit("homebound", (at) => Effect.map(stock(join(at, "elsewhere")), (inner) => Shell.of({ run: ({ cwd: _, ...request }) => inner.run(request) }))),
        // It gives a command a variable it was not given.
        leaking: kit("leaking", (at) => changed(at, (inner) => inner.run, { env: { ...ENV, NOT_GIVEN: "the host's" } })),
        // It lets a command run as long as it likes.
        timeless: kit("timeless", (at) => changed(at, (inner) => ({ timeoutMs: _, ...request }) => inner.run(request))),
        // Each stops the shell alone, not what it started, on one way a run ends.
        onTimeout: kit("on-timeout", (at) => leaky(at, "timeout", started)),
        onReturn: kit("on-return", (at) => leaky(at, "return", started)),
        onInterrupt: kit("on-interrupt", (at) => leaky(at, "interrupt", started)),
        onClose: kit("on-close", (at) => leaky(at, "close", started)),
      }, { concurrency: "unbounded" })
      return all
    })))
    expect(failed).toEqual({
      zeroed: ["exit"],
      merged: ["output"],
      unbounded: ["bounded"],
      homebound: ["cwd"],
      leaking: ["environment"],
      timeless: ["timeout", "timeout-kills"],
      onTimeout: ["timeout-kills"],
      onReturn: ["return-kills"],
      onInterrupt: ["interrupt-kills"],
      onClose: ["close-kills"],
    })
  }, 90_000)
})
