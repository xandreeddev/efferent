import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail } from "../conformance.functions.js"
import type { BashEvent, BashOptions, BashResult } from "../domain/bash.entity.js"
import type { Bash } from "../ports/bash.port.js"

type BashShape = Context.Service.Shape<typeof Bash>

/** One check's Bash adapter and an empty directory its commands run in. */
export interface BashFixture {
  readonly bash: BashShape
  /** An absolute directory that exists and is empty. */
  readonly root: string
}

/**
 * A Bash backend as the kit opens it, once per check, released with its
 * scope. The adapter's parent environment must be the process's own plus
 * `planted`, so the kit can check what a command inherits (a Node adapter
 * reads `{ ...process.env, ...planted }` where it would read
 * `process.env`). The shell itself is found the way the adapter always
 * finds it, not through the command's environment.
 */
export interface BashSubject {
  readonly open: (planted: Readonly<Record<string, string>>) => Effect.Effect<BashFixture, unknown, Scope.Scope>
  /**
   * Whether a reader that falls behind holds the command back (true when
   * left out). Bun (1.3) reads a child's pipes ahead of any reader into its
   * own memory, so an adapter over those pipes declares false there, and the
   * backpressure check then asks only that a slow reader gets all of the
   * output, in order.
   */
  readonly holdsBack?: boolean
}

const show = (value: unknown): string => JSON.stringify(value)
/** A word the shell reads literally. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`
const textOf = (events: ReadonlyArray<BashEvent>, stream: "stdout" | "stderr"): string =>
  events.flatMap((event) => event._tag === "BashChunk" && event.stream === stream ? [event.text] : []).join("")
const ended = (result: BashResult) => show({
  termination: result.termination, exitCode: Option.getOrNull(result.exitCode), signal: Option.getOrNull(result.signal), stdout: result.stdout, stderr: result.stderr,
})

/** Prints `gone` or `alive` for the process whose id is in each file; a zombie is gone. */
const statusOf = (pidFiles: ReadonlyArray<string>): string => pidFiles.map((file) =>
  `pid=$(cat ${quoted(file)} 2>/dev/null) || { echo missing; exit 0; }; if kill -0 "$pid" 2>/dev/null; then case "$(ps -o stat= -p "$pid" 2>/dev/null)" in Z*) echo gone ;; *) echo alive ;; esac; else echo gone; fi`,
).join("; ")

/** Planted in the parent environment by the inheritance checks. */
const planted = { EFFERENT_KIT_SECRET: "planted-secret", LC_EFFERENT_KIT: "planted-locale", EFFERENT_KIT_OVER: "from the parent" }

/**
 * The Bash contract as checks, each with a fresh fixture: a non-zero exit
 * is a result; stdout and stderr stay apart and arrive as chunks while the
 * command still runs, with exactly one `BashExit`, last; `stdin` (text or
 * bytes) is delivered, its end is seen, and a command that ignores a large
 * one still exits; `env` is set over the parent environment, which is filtered by
 * `inheritEnv` (the default allowlist keeps `PATH` and `LC_*` but not a
 * planted secret); a timeout kills the whole process group, a background
 * child included, and reports `timeout`; `cwd` is honoured and a missing one
 * fails with `CwdMissing`; a signal is reported; UTF-8 split across writes
 * arrives whole; a reader that falls behind holds the command back (output
 * is never gathered without bound; see `holdsBack`) and still gets all of
 * it, in order;
 * interrupting the stream kills the command and what it started. Each must
 * finish within 30 seconds.
 */
export const bashConformance = (subject: BashSubject): ReadonlyArray<ConformanceCheck> => {
  const bashCheck = (name: string, id: string, body: (fixture: BashFixture) => Effect.Effect<void, unknown, Scope.Scope>, plant: Readonly<Record<string, string>> = {}): ConformanceCheck =>
    check(name, id, () => Effect.timeoutOrElse(Effect.scoped(subject.open(plant).pipe(Effect.flatMap(body))), {
      duration: "30 seconds",
      orElse: () => fail(id, "the check did not finish in 30 seconds"),
    }))
  const run = (fixture: BashFixture, command: string, options: Omit<BashOptions, "cwd"> = {}) => fixture.bash.exec(command, { ...options, cwd: fixture.root })
  /** Poll until every process is gone, for up to five seconds. */
  const allGone = (fixture: BashFixture, pidFiles: ReadonlyArray<string>, polls = 50): Effect.Effect<string, unknown> =>
    run(fixture, statusOf(pidFiles)).pipe(Effect.flatMap((result) => {
      const statuses = result.stdout.trim()
      return statuses.split("\n").every((status) => status === "gone") || polls === 0 ? Effect.succeed(statuses)
        : Effect.sleep("100 millis").pipe(Effect.andThen(allGone(fixture, pidFiles, polls - 1)))
    }))
  /**
   * Run `command` as a stream on a fiber of its own, and wait (up to ten
   * seconds) until its stdout so far contains `marker`; false when the
   * stream ended first or the time ran out.
   */
  const runUntil = (fixture: BashFixture, command: string, marker: string) => Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<BashEvent>>([])
    const seen = yield* Deferred.make<boolean>()
    const fiber = yield* Effect.forkScoped(Stream.runForEach(fixture.bash.stream(command, { cwd: fixture.root }), (event) => Ref.updateAndGet(events, (all) => [...all, event]).pipe(
      Effect.flatMap((all) => textOf(all, "stdout").includes(marker) ? Deferred.succeed(seen, true) : Effect.void),
    )).pipe(Effect.ensuring(Deferred.succeed(seen, false))))
    const arrived = Option.getOrElse(yield* Deferred.await(seen).pipe(Effect.timeoutOption("10 seconds")), () => false)
    return { events, fiber, arrived }
  })

  return [
    bashCheck("a non-zero exit is a result with its code, not an error", "exit-code", (fixture) => Effect.gen(function* () {
      const failed = yield* run(fixture, "echo bad >&2; exit 3")
      yield* expect("exit-code", failed.termination === "exit" && Option.getOrNull(failed.exitCode) === 3 && Option.isNone(failed.signal) && failed.stderr === "bad\n",
        `a command exiting 3 ended ${ended(failed)}`)
      const succeeded = yield* run(fixture, "true")
      yield* expect("exit-code", succeeded.termination === "exit" && Option.getOrNull(succeeded.exitCode) === 0, `true ended ${ended(succeeded)}`)
    })),
    bashCheck("stdout and stderr stay apart, chunks carry their stream, and exactly one BashExit comes last", "streams", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, "printf out1; printf err1 >&2; printf out2; printf err2 >&2")
      yield* expect("streams", result.stdout === "out1out2" && result.stderr === "err1err2", `the command ended ${ended(result)}`)
      const events = yield* Stream.runCollect(fixture.bash.stream("printf 'one\\n'; printf 'two\\n' >&2; exit 4", { cwd: fixture.root })).pipe(Effect.map((all) => [...all]))
      const exits = events.filter((event) => event._tag === "BashExit")
      const last = events.at(-1)
      yield* expect("streams", textOf(events, "stdout") === "one\n" && textOf(events, "stderr") === "two\n",
        `the stream's chunks gave stdout ${show(textOf(events, "stdout"))} and stderr ${show(textOf(events, "stderr"))}`)
      yield* expect("streams", exits.length === 1 && last?._tag === "BashExit" && Option.getOrNull(last.exitCode) === 4,
        `the stream had ${exits.length} BashExit events and ended with ${show(last?._tag)}`)
    })),
    bashCheck("output arrives while the command still runs, before its exit", "streaming", (fixture) => Effect.gen(function* () {
      // The command cannot exit until the kit has seen its first output: an adapter that holds output back until exit times out here.
      yield* Effect.addFinalizer(() => run(fixture, "touch go").pipe(Effect.ignore))
      const started = yield* runUntil(fixture, "printf first; while [ ! -e go ]; do sleep 0.05; done; printf second", "first")
      if (!started.arrived) return yield* fail("streaming", "the first output did not arrive while the command ran (is output held until exit?)")
      yield* run(fixture, "touch go")
      const joined = yield* Fiber.join(started.fiber).pipe(Effect.timeoutOption("10 seconds"))
      if (Option.isNone(joined)) return yield* fail("streaming", "the command did not end after it was let go")
      const events = yield* Ref.get(started.events)
      const last = events.at(-1)
      yield* expect("streaming", textOf(events, "stdout") === "firstsecond" && last?._tag === "BashExit" && Option.getOrNull(last.exitCode) === 0
        && events.filter((event) => event._tag === "BashExit").length === 1, `the stream gave ${show(textOf(events, "stdout"))}, ending with ${show(last)}`)
    })),
    bashCheck("stdin, text or bytes, is delivered and then closed; without stdin the command reads end-of-file at once", "stdin", (fixture) => Effect.gen(function* () {
      const input = "line one\nlïne two ✓\nno newline at the end"
      const echoed = yield* run(fixture, "cat", { stdin: input })
      yield* expect("stdin", echoed.stdout === input && Option.getOrNull(echoed.exitCode) === 0, `cat of stdin ended ${ended(echoed)}`)
      const counted = yield* run(fixture, "wc -c", { stdin: Uint8Array.from([0, 255, 10, 128, 7]) })
      yield* expect("stdin", counted.stdout.trim() === "5" && Option.getOrNull(counted.exitCode) === 0, `wc -c of five bytes of stdin ended ${ended(counted)}`)
      const empty = yield* run(fixture, "cat; printf done").pipe(Effect.timeoutOption("10 seconds"))
      yield* Option.match(empty, {
        onNone: () => fail("stdin", "cat without stdin did not end in 10 seconds: its input was left open"),
        onSome: (result) => expect("stdin", result.stdout === "done", `cat without stdin ended ${ended(result)}`),
      })
    })),
    bashCheck("a command that ignores a large stdin and exits still yields its exit", "stdin-ignored", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, "printf ignored", { stdin: "x".repeat(1_000_000) })
      yield* expect("stdin-ignored", result.termination === "exit" && Option.getOrNull(result.exitCode) === 0 && result.stdout === "ignored", `the command ended ${ended(result)}`)
    })),
    bashCheck("env is set over the parent environment", "env", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, `printf '%s|%s' "$EFFERENT_KIT_VALUE" "$EFFERENT_KIT_OVER"`, {
        env: { EFFERENT_KIT_VALUE: "välue with spaces", EFFERENT_KIT_OVER: "from env" }, inheritEnv: true,
      })
      yield* expect("env", result.stdout === "välue with spaces|from env", `the command saw ${show(result.stdout)}`)
    }), planted),
    bashCheck("by default the parent environment passes through an allowlist: PATH and LC_* but not a planted secret; inheritEnv widens or empties it", "inherit-env", (fixture) => Effect.gen(function* () {
      const probe = `printf '%s|%s|%s' "\${EFFERENT_KIT_SECRET-unset}" "\${LC_EFFERENT_KIT-unset}" "\${PATH:+path}"`
      const settings: ReadonlyArray<Option.Option<boolean | ReadonlyArray<string>>> = [Option.none(), Option.some(true), Option.some(false), Option.some(["EFFERENT_KIT_*"])]
      const seen = yield* Effect.forEach(settings, (inheritEnv) =>
        run(fixture, probe, Option.match(inheritEnv, { onNone: () => ({}), onSome: (value) => ({ inheritEnv: value }) })).pipe(Effect.map((result) => result.stdout)))
      const expected = [
        "unset|planted-locale|path",
        "planted-secret|planted-locale|path",
        "unset|unset|",
        "planted-secret|unset|",
      ]
      const [byDefault, all, none, listed] = seen
      yield* expect("inherit-env", byDefault === expected[0] && all === expected[1], `by default the command saw ${show(byDefault)} and with inheritEnv true ${show(all)}; expected ${show(expected.slice(0, 2))}`)
      // Without an inherited PATH bash may set one of its own: only the planted names are checked.
      yield* expect("inherit-env", none?.startsWith("unset|unset|") === true && listed?.startsWith("planted-secret|unset|") === true,
        `with inheritEnv false the command saw ${show(none)}, with an allowlist of EFFERENT_KIT_* ${show(listed)}`)
    }), planted),
    bashCheck("a timeout kills the whole process group, a background child too, and reports termination timeout", "timeout", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, "sleep 30 & echo $! > child.pid; printf started; wait", { timeoutMs: 1000 })
      yield* expect("timeout", result.termination === "timeout" && Option.isNone(result.exitCode) && result.stdout === "started" && result.durationMs < 10_000,
        `a command past its 1 s timeout ended ${ended(result)} after ${result.durationMs} ms`)
      const status = yield* allGone(fixture, ["child.pid"])
      yield* expect("timeout", status === "gone", `the background child of the timed-out command is ${status}`)
    })),
    bashCheck("the command runs in cwd, and a missing cwd or one that is a file fails with CwdMissing", "cwd", (fixture) => Effect.gen(function* () {
      yield* run(fixture, "printf here > marker.txt; printf x > afile")
      const marker = yield* fixture.bash.exec(`cat ${quoted(`${fixture.root}/marker.txt`)}`, { cwd: "/" })
      yield* expect("cwd", marker.stdout === "here", `a file written in cwd reads ${show(marker.stdout)} from its absolute path`)
      const missing = yield* Effect.flip(fixture.bash.exec("true", { cwd: `${fixture.root}/missing` }))
      const file = yield* Effect.flip(fixture.bash.exec("true", { cwd: `${fixture.root}/afile` }))
      yield* expect("cwd", missing._tag === "BashError" && missing.reason === "CwdMissing" && file._tag === "BashError" && file.reason === "CwdMissing",
        `a missing cwd failed with ${show(missing)}, a file as cwd with ${show(file)}`)
    })),
    bashCheck("a command killed by a signal reports termination signal and the signal's name", "signal", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, "kill -TERM $$")
      yield* expect("signal", result.termination === "signal" && Option.getOrNull(result.signal) === "SIGTERM" && Option.isNone(result.exitCode), `kill -TERM $$ ended ${ended(result)}`)
    })),
    bashCheck("UTF-8 written in two pieces arrives as whole characters", "utf8", (fixture) => Effect.gen(function* () {
      const result = yield* run(fixture, "printf '\\303'; sleep 0.2; printf '\\251\\n'; printf '\\342\\234' >&2; sleep 0.2; printf '\\223' >&2")
      yield* expect("utf8", result.stdout === "é\n" && result.stderr === "✓", `a split é and ✓ arrived as ${show(result.stdout)} and ${show(result.stderr)}`)
    })),
    bashCheck("a reader that falls behind holds the command back, then gets all of its output in order", "backpressure", (fixture) => Effect.gen(function* () {
      // 64 MB of "y\n": far more than an adapter may hold for a reader that stopped after the first chunk.
      const size = 64 * 1024 * 1024
      const first = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const reading = yield* Effect.forkScoped(fixture.bash.stream(`yes | head -c ${size}; touch written`, { cwd: fixture.root }).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(go)))),
        Stream.runFold(() => ({ bytes: 0, ordered: true, last: "\n", exits: 0 }), (state, event) => event._tag === "BashExit" ? { ...state, exits: state.exits + 1 } : {
          bytes: state.bytes + event.text.length,
          ordered: state.ordered && event.stream === "stdout" && !`${state.last}${event.text}`.includes("yy") && !`${state.last}${event.text}`.includes("\n\n"),
          last: event.text.at(-1) ?? state.last,
          exits: state.exits,
        }),
        Effect.ensuring(Deferred.succeed(first, undefined)),
      ))
      yield* Deferred.await(first)
      yield* Effect.sleep("1 second")
      const meanwhile = yield* run(fixture, "if [ -e written ]; then echo finished; else echo held; fi")
      yield* Deferred.succeed(go, undefined)
      const read = yield* Fiber.join(reading)
      if (subject.holdsBack !== false) yield* expect("backpressure", meanwhile.stdout === "held\n",
        "the command wrote all of its output while its reader was stuck on the first chunk: the adapter gathered it without bound")
      yield* expect("backpressure", read.bytes === size && read.ordered && read.exits === 1,
        `once read, the output was ${read.bytes} of ${size} characters, ${read.ordered ? "in order" : "out of order"}, with ${read.exits} BashExit events`)
    })),
    bashCheck("interrupting the stream kills the command and what it started, and returns", "interrupt", (fixture) => Effect.gen(function* () {
      const started = yield* runUntil(fixture, "sleep 30 & echo $! > child.pid; echo $$ > shell.pid; printf started; wait", "started")
      if (!started.arrived) return yield* fail("interrupt", "the command's output did not arrive")
      const interrupted = yield* Fiber.interrupt(started.fiber).pipe(Effect.timeoutOption("10 seconds"))
      if (Option.isNone(interrupted)) return yield* fail("interrupt", "interrupting the stream did not return in 10 seconds")
      const status = yield* allGone(fixture, ["shell.pid", "child.pid"])
      yield* expect("interrupt", status === "gone\ngone", `after the interrupt the shell and its child are ${show(status.split("\n"))}`)
    })),
  ]
}
