import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { Cause, Clock, Effect, Exit, Fiber, Option, Queue, Ref, Stream, Tracer } from "effect"
import type { Context } from "effect"
import { Bash, BashError, bashConformance } from "@xandreed/core"
import type { BashEvent, BashSubject } from "@xandreed/core"
import { BashLive, makeBash, relayOutput } from "./bash.adapter.js"
import type { BashLiveOptions } from "./local-system.entity.js"

/** A fresh directory under the system's temporary directory, removed with its scope. */
const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-bash-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)

const subject: BashSubject = {
  open: (planted) => Effect.all({ root: temporary, bash: makeBash({ parentEnv: { ...process.env, ...planted } }) }),
  // Bun reads a child's pipes ahead of the reader; on Node (verify:packages) the kit checks the command is held back.
  holdsBack: process.versions["bun"] === undefined,
}

type BashShape = Context.Service.Shape<typeof Bash>

/** Run `body` with a Bash built from `options` and an empty directory. */
const withBash = <A>(options: BashLiveOptions, body: (bash: BashShape, root: string) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.scoped(Effect.all({ root: temporary, bash: makeBash(options) }).pipe(Effect.flatMap(({ bash, root }) => body(bash, root)))))

/** `alive` or `gone` for the process whose id is in `file` (a zombie is gone). */
const statusOf = (bash: BashShape, root: string, file = "child.pid") => bash.exec(
  `pid=$(cat ${file}); if kill -0 "$pid" 2>/dev/null; then case "$(ps -o stat= -p "$pid")" in Z*) echo gone ;; *) echo alive ;; esac; else echo gone; fi`,
  { cwd: root },
).pipe(Effect.map((result) => result.stdout.trim()))

describe("the local Bash passes the Bash kit", () => {
  bashConformance(subject).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }, 40_000))
})

describe("the local Bash", () => {
  // Under Bun no write fails here (it reports no EPIPE), so the stdin error listener is reached on Node only:
  // verify:packages runs the kit's stdin-ignored check (a megabyte of stdin) over the packed adapter there.
  test("a command that ignores a large stdin, or reads a byte of it, exits normally: the broken pipe is not an error", async () => {
    const results = await withBash({}, (bash, root) => Effect.forEach(["exit 0", "head -c 1", "printf ignored; exec 0<&-; sleep 0.1"], (command) =>
      bash.exec(command, { cwd: root, stdin: "y".repeat(8_000_000) }).pipe(Effect.map((result) => [result.termination, Option.getOrNull(result.exitCode), result.stdout])),
    { concurrency: 3 }))
    expect(results).toEqual([["exit", 0, ""], ["exit", 0, "y"], ["exit", 0, "ignored"]])
  }, 20_000)

  test("by default the process group dies when the command returns; with killBackground false a background child lives on", async () => {
    const outcome = await withBash({}, (bash, root) => Effect.gen(function* () {
      const killed = yield* bash.exec("sleep 30 & echo $! > child.pid", { cwd: root })
      yield* Effect.sleep("200 millis")
      return { termination: killed.termination, child: yield* statusOf(bash, root) }
    }))
    expect(outcome).toEqual({ termination: "exit", child: "gone" })
    const kept = await withBash({ killBackground: false, exitGraceMs: 300 }, (bash, root) => Effect.gen(function* () {
      // The child keeps stdout open: the stream ends exitGraceMs after the shell exits, not when the child does.
      const started = yield* Clock.currentTimeMillis
      const result = yield* bash.exec("sleep 30 & echo $! > child.pid; printf started", { cwd: root })
      const waited = (yield* Clock.currentTimeMillis) - started
      const child = yield* statusOf(bash, root)
      yield* bash.exec("kill -9 \"$(cat child.pid)\"", { cwd: root })
      return { termination: result.termination, stdout: result.stdout, afterGrace: waited >= 250, beforeChild: waited < 5_000, child }
    }))
    expect(kept).toEqual({ termination: "exit", stdout: "started", afterGrace: true, beforeChild: true, child: "alive" })
  }, 20_000)

  test("with killBackground false, a background child that still writes to the command's output dies once it closes; one with its own output lives on", async () => {
    const outcome = await withBash({ killBackground: false, exitGraceMs: 100 }, (bash, root) => Effect.gen(function* () {
      const writer = "sleep 0.4; while :; do echo late; sleep 0.1; done"
      yield* bash.exec(`sh -c '${writer}' & echo $! > noisy.pid; sh -c '${writer}' > quiet.log 2>&1 & echo $! > quiet.pid`, { cwd: root })
      yield* Effect.sleep("1200 millis")
      const status = { noisy: yield* statusOf(bash, root, "noisy.pid"), quiet: yield* statusOf(bash, root, "quiet.pid") }
      yield* bash.exec("kill -9 \"$(cat noisy.pid)\" \"$(cat quiet.pid)\" 2>/dev/null; true", { cwd: root })
      return status
    }))
    expect(outcome).toEqual({ noisy: "gone", quiet: "alive" })
  }, 20_000)

  test("the shell is found on the parent PATH or at an absolute path; a missing one fails the layer with ShellMissing, bash included (no fallback to sh)", async () => {
    const sh = await withBash({ shell: "sh" }, (bash, root) => bash.exec("printf ok", { cwd: root, inheritEnv: false }))
    expect([sh.stdout, Option.getOrNull(sh.exitCode)]).toEqual(["ok", 0])
    const missing = await Effect.runPromise(Effect.flip(makeBash({ shell: "efferent-no-such-shell" })))
    const noPath = await Effect.runPromise(Effect.flip(makeBash({ parentEnv: { PATH: "/efferent/nowhere" } })))
    expect([missing.reason, noPath.reason]).toEqual(["ShellMissing", "ShellMissing"])
    const layer = await Effect.runPromise(Effect.flip(Effect.service(Bash).pipe(Effect.provide(BashLive({ shell: "/efferent/nowhere/bash" })))))
    expect(layer.reason).toBe("ShellMissing")
    // A PATH with sh and no bash: the default shell is missing, and sh runs only when named.
    const onlySh = await Effect.runPromise(Effect.scoped(temporary.pipe(Effect.flatMap((bin) => Effect.gen(function* () {
      const shPath = yield* Effect.promise(() => realpath("/bin/sh"))
      yield* Effect.promise(() => symlink(shPath, join(bin, "sh")))
      const bash = yield* Effect.flip(makeBash({ parentEnv: { PATH: bin } }))
      const named = yield* makeBash({ shell: "sh", parentEnv: { PATH: bin } }).pipe(Effect.flatMap((shell) => shell.exec("printf named", { cwd: bin })))
      return [bash.reason, named.stdout]
    })))))
    expect(onlySh).toEqual(["ShellMissing", "named"])
  })

  test("a stream cut short by its consumer kills the command and what it started, and ends without a BashExit", async () => {
    const outcome = await withBash({}, (bash, root) => Effect.gen(function* () {
      const events = yield* Stream.runCollect(bash.stream("echo $$ > shell.pid; sleep 30 & echo $! > child.pid; printf first; wait; printf never", { cwd: root }).pipe(Stream.take(1)))
      yield* Effect.sleep("200 millis")
      return { events: [...events], shell: yield* statusOf(bash, root, "shell.pid"), child: yield* statusOf(bash, root) }
    }))
    expect(outcome).toEqual({ events: [{ _tag: "BashChunk", stream: "stdout", text: "first" }], shell: "gone", child: "gone" })
  }, 20_000)

  test("each exec is one bash.exec span, ended with its failure; building the adapter and streaming open none", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
    await Effect.runPromise(Effect.scoped(Effect.all({ root: temporary, bash: makeBash({}) }).pipe(
      Effect.flatMap(({ bash, root }) => Effect.all([
        bash.exec("printf ok", { cwd: root }),
        Effect.flip(bash.exec("true", { cwd: `${root}/missing` })),
        Stream.runDrain(bash.stream("printf ok", { cwd: root })),
      ], { concurrency: 1 })),
      Effect.withTracer(tracer),
    )))
    expect(spans.map((span) => span.name)).toEqual(["bash.exec", "bash.exec"])
    expect(spans.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))).toEqual([false, true])
  })
})

describe("the output relay", () => {
  /** A relay over a stream buffer of `capacity` events and two pipes the test writes to. */
  const relayed = (capacity: number) => Effect.gen(function* () {
    const queue = yield* Queue.make<BashEvent, BashError | Cause.Done>({ capacity })
    const relay = yield* relayOutput(queue)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    relay.attach("stdout", stdout)
    relay.attach("stderr", stderr)
    return { queue, relay, stdout, stderr }
  })
  const exit: BashEvent = { _tag: "BashExit", termination: "exit", exitCode: Option.some(0), signal: Option.none(), durationMs: 1 }
  const settle = Effect.sleep("20 millis")

  test("pauses the pipes while the stream's buffer is full, resumes them as it is read, and keeps the order", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { queue, relay, stdout, stderr } = yield* relayed(2)
      yield* Effect.forEach(["a", "b", "c"], (text) => Effect.sync(() => stdout.write(text)).pipe(Effect.andThen(settle)), { discard: true })
      yield* Effect.sync(() => stderr.write("d")).pipe(Effect.andThen(settle))
      const whileFull = { stdout: stdout.isPaused(), stderr: stderr.isPaused(), buffered: Queue.sizeUnsafe(queue) }
      // Written while its pipe is paused: it comes after what waits before it.
      yield* Effect.sync(() => stdout.write("é")).pipe(Effect.andThen(settle))
      const reader = yield* Effect.forkScoped(Stream.runCollect(Stream.fromQueue(queue)))
      yield* settle
      const resumed = { stdout: stdout.isPaused(), stderr: stderr.isPaused() }
      relay.flow()
      // The first byte of a two-byte character, which never gets its second.
      yield* Effect.sync(() => stdout.write(Uint8Array.from([0xc3]))).pipe(Effect.andThen(settle))
      relay.finish(exit)
      return { whileFull, resumed, all: [...yield* Fiber.join(reader)] }
    })))
    expect(seen.whileFull).toEqual({ stdout: true, stderr: true, buffered: 2 })
    expect(seen.resumed).toEqual({ stdout: false, stderr: false })
    // A byte left over from a split character is flushed as U+FFFD when the stream finishes, before the exit.
    expect(seen.all.map((event) => event._tag === "BashChunk" ? `${event.stream}:${event.text}` : event._tag))
      .toEqual(["stdout:a", "stdout:b", "stdout:c", "stderr:d", "stdout:é", "stdout:\uFFFD", "BashExit"])
  })

  test("an error reading a pipe fails the stream with SpawnFailed, after the output before it", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { queue, stdout } = yield* relayed(16)
      yield* Effect.sync(() => stdout.write("before")).pipe(Effect.andThen(settle))
      yield* Effect.sync(() => stdout.destroy(new Error("read failed")))
      const texts = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* Stream.fromQueue(queue).pipe(
        Stream.runForEach((event) => Ref.update(texts, (all) => [...all, event._tag === "BashChunk" ? event.text : event._tag])),
        Effect.result,
      )
      return { texts: yield* Ref.get(texts), failure: result._tag === "Failure" ? [result.failure.reason, result.failure.message] : [] }
    })))
    expect(outcome).toEqual({ texts: ["before"], failure: ["SpawnFailed", "could not read the command's stdout: read failed"] })
  })
})
