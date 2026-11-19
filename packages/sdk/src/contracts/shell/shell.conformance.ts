import { Effect, Exit, Fiber, Scope } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core"
import { expect, fail, show, unexpected } from "../conformance.entity.functions.js"
import type { Ran } from "./shell.entity.js"
import type { Shell } from "./shell.port.js"

type ShellShape = Context.Service.Shape<typeof Shell>

/**
 * A shell as the kit opens it: a fresh one per check, closed with its scope. `folder` is the subject's own folder, which
 * no other kit run uses at the same time, where the kit's commands start and write small files (an absolute path, as
 * `pwd -P` prints it); `env` is every variable the shell was
 * built to give a command, and nothing else may reach one; `outputBytes` is how much of each stream it keeps.
 *
 * @public
 */
export interface ShellSubject {
  readonly open: Effect.Effect<ShellShape, never, Scope.Scope>
  readonly folder: string
  readonly env: Readonly<Record<string, string>>
  readonly outputBytes: number
}

/** The variables a POSIX shell sets for itself, which a command sees whatever it was given. */
const SHELL_OWN: ReadonlySet<string> = new Set(["PWD", "OLDPWD", "SHLVL", "_"])

/** How long the kit waits for a process to start or to be gone: far longer than either takes. */
const PATIENCE_MS = 10_000
const STEP_MS = 50

const bytesOf = (text: string): number => new TextEncoder().encode(text).length
const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

const ran = (check: string, shell: ShellShape, command: string, more: { readonly cwd?: string; readonly timeoutMs?: number } = {}) =>
  shell.run({ command, ...more }).pipe(unexpected(check))

const ended = (check: string, what: string, got: Ran, tag: Ran["ended"]["_tag"]) =>
  expect(check, got.ended._tag === tag, `${what} ended ${show(got.ended)}, not ${tag}`)

/** Wait, a step at a time and no longer than `PATIENCE_MS`, until `probe` holds; `what` says what was waited for. */
const until = (check: string, what: string, probe: Effect.Effect<boolean, ConformanceFailure>) => Effect.gen(function* () {
  for (let waited = 0; waited < PATIENCE_MS; waited += STEP_MS) {
    if (yield* probe) return
    yield* Effect.sleep(`${STEP_MS} millis`)
  }
  return yield* fail(check, `${what}: still not so after ${PATIENCE_MS / 1000} seconds`)
})

/** The pid a command wrote to `file` in the kit's folder, read through the shell; none while it is not written. */
const pidIn = (check: string, shell: ShellShape, folder: string, file: string) =>
  Effect.map(ran(check, shell, `cat ${quoted(file)} 2>/dev/null`, { cwd: folder }), (got) => /^\d+$/.test(got.stdout.trim()) ? Number(got.stdout.trim()) : 0)

/** Whether a process of this machine is gone, asked through the shell. */
const gone = (check: string, shell: ShellShape, pid: number) =>
  Effect.map(ran(check, shell, `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`), (got) => got.stdout.trim() === "gone")

/** A command that starts `sleep 30` in the background, writes its pid to `file`, and waits for it. */
const sleeper = (file: string, wait = true) => `sleep 30 & echo $! > ${quoted(file)}${wait ? "; wait" : ""}`

/** Remove a pid file a run before this one left, so a check never reads a pid that is not its command's. */
const cleared = (check: string, shell: ShellShape, folder: string, file: string) => Effect.asVoid(ran(check, shell, `rm -f ${quoted(file)}`, { cwd: folder }))

/** Wait for the pid in `file`, then for its process to be gone. */
const reaped = (check: string, shell: ShellShape, folder: string, file: string, what: string) => Effect.gen(function* () {
  let pid = 0
  yield* until(check, `the background process's pid in ${file}`, Effect.map(pidIn(check, shell, folder, file), (found) => { pid = found; return found > 0 }))
  yield* until(check, `${what}: the background process ${pid} the command started is gone`, gone(check, shell, pid))
})

/** Fail the check when `self` takes longer than `PATIENCE_MS`. */
const bounded = (check: string, what: string) => <A, R>(self: Effect.Effect<A, ConformanceFailure, R>) =>
  Effect.timeoutOrElse(self, { duration: `${PATIENCE_MS} millis`, orElse: () => fail(check, `${what} did not end in ${PATIENCE_MS / 1000} seconds`) })

const checks = (subject: ShellSubject): ReadonlyArray<readonly [string, string, (shell: ShellShape) => Effect.Effect<void, ConformanceFailure, Scope.Scope>]> => [
  ["exit", "a command's exit code is read, 0 and not 0, and neither is a failure", (shell) => Effect.gen(function* () {
    const three = yield* ran("exit", shell, "exit 3")
    yield* expect("exit", show(three.ended) === show({ _tag: "Exited", code: 3 }), `exit 3 ended ${show(three.ended)}`)
    const zero = yield* ran("exit", shell, "true")
    yield* expect("exit", show(zero.ended) === show({ _tag: "Exited", code: 0 }), `true ended ${show(zero.ended)}`)
  })],
  ["output", "stdout and stderr are each the command's own, as UTF-8, nothing cut", (shell) => Effect.gen(function* () {
    const got = yield* ran("output", shell, "printf 'out é 😀'; printf 'err' >&2")
    yield* expect("output", got.stdout === "out é 😀" && got.stderr === "err", `stdout ${show(got.stdout)} and stderr ${show(got.stderr)}`)
    yield* expect("output", got.stdoutCut === 0 && got.stderrCut === 0, `cut ${got.stdoutCut} and ${got.stderrCut} bytes of short output`)
  })],
  ["bounded", "output over the bound keeps its end, never half a character, and counts the bytes left out", (shell) => Effect.gen(function* () {
    // Twice the bound in two-byte characters, then an end: the end is kept, and the cut falls between characters.
    const lines = subject.outputBytes
    const got = yield* ran("bounded", shell, `yes é | head -n ${lines} | tr -d '\\n'; printf END`)
    const kept = bytesOf(got.stdout)
    yield* expect("bounded", got.stdout.endsWith("éééEND"), `the output kept ends ${show(got.stdout.slice(-12))}, not with what was written last`)
    yield* expect("bounded", kept <= subject.outputBytes, `${kept} bytes were kept, more than the bound of ${subject.outputBytes}`)
    yield* expect("bounded", kept >= subject.outputBytes - 4, `${kept} bytes were kept, far less than the bound of ${subject.outputBytes}`)
    yield* expect("bounded", !got.stdout.includes("�"), "the output kept starts inside a character")
    yield* expect("bounded", kept + got.stdoutCut === 2 * lines + 3, `${kept} kept and ${got.stdoutCut} cut make ${kept + got.stdoutCut} bytes, not the ${2 * lines + 3} written`)
  })],
  ["cwd", "a command starts in the folder it is given", (shell) => Effect.gen(function* () {
    const got = yield* ran("cwd", shell, "pwd -P", { cwd: subject.folder })
    yield* expect("cwd", got.stdout.trim() === subject.folder, `pwd -P printed ${show(got.stdout.trim())}, not ${show(subject.folder)}`)
  })],
  ["environment", "a command sees the variables the shell was given and no other but the shell's own", (shell) => Effect.gen(function* () {
    const got = yield* ran("environment", shell, "env")
    const seen = new Map(got.stdout.split("\n").flatMap((line) => {
      const at = line.indexOf("=")
      return at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, at)) ? [[line.slice(0, at), line.slice(at + 1)] as const] : []
    }))
    const missing = Object.entries(subject.env).filter(([name, value]) => seen.get(name) !== value).map(([name]) => name)
    yield* expect("environment", missing.length === 0, `the command did not see ${show(missing)} as given`)
    const extra = Array.from(seen.keys()).filter((name) => !(name in subject.env) && !SHELL_OWN.has(name))
    yield* expect("environment", extra.length === 0, `the command saw variables it was not given: ${show(extra)}`)
  })],
  ["timeout", "a command that runs past its time ends TimedOut, at once", (shell) => Effect.gen(function* () {
    const got = yield* ran("timeout", shell, "sleep 30", { timeoutMs: 300 }).pipe(bounded("timeout", "a command with a timeout of 300 ms"))
    yield* ended("timeout", "sleep 30 with a timeout of 300 ms", got, "TimedOut")
  })],
  ["timeout-kills", "a timeout stops every process the command started", (shell) => Effect.gen(function* () {
    yield* cleared("timeout-kills", shell, subject.folder, "timeout.pid")
    const got = yield* ran("timeout-kills", shell, sleeper("timeout.pid"), { cwd: subject.folder, timeoutMs: 1000 }).pipe(bounded("timeout-kills", "a command with a timeout of 1 s"))
    yield* ended("timeout-kills", "a command that waits for its background process", got, "TimedOut")
    yield* reaped("timeout-kills", shell, subject.folder, "timeout.pid", "after the timeout")
  })],
  ["return-kills", "a command that returns leaves no process it started running", (shell) => Effect.gen(function* () {
    yield* cleared("return-kills", shell, subject.folder, "return.pid")
    const got = yield* ran("return-kills", shell, sleeper("return.pid", false), { cwd: subject.folder }).pipe(bounded("return-kills", "a command that leaves a process in the background"))
    yield* ended("return-kills", "a command that returns at once", got, "Exited")
    yield* reaped("return-kills", shell, subject.folder, "return.pid", "after the command returned")
  })],
  ["interrupt-kills", "an interrupted run stops every process the command started", (shell) => Effect.gen(function* () {
    yield* cleared("interrupt-kills", shell, subject.folder, "interrupt.pid")
    const running = yield* Effect.forkChild(shell.run({ command: sleeper("interrupt.pid"), cwd: subject.folder }))
    let pid = 0
    yield* until("interrupt-kills", "the background process's pid in interrupt.pid", Effect.map(pidIn("interrupt-kills", shell, subject.folder, "interrupt.pid"), (found) => { pid = found; return found > 0 }))
    yield* Fiber.interrupt(running).pipe(bounded("interrupt-kills", "the interruption of a running command"))
    yield* until("interrupt-kills", `after the interruption: the background process ${pid} the command started is gone`, gone("interrupt-kills", shell, pid))
  })],
  ["close-kills", "the close of the shell's scope stops every process its commands started", (shell) => Effect.gen(function* () {
    yield* cleared("close-kills", shell, subject.folder, "close.pid")
    const inner = yield* Scope.make()
    const closing = yield* Scope.provide(subject.open, inner)
    const running = yield* Effect.forkDetach(closing.run({ command: sleeper("close.pid"), cwd: subject.folder }))
    let pid = 0
    yield* until("close-kills", "the background process's pid in close.pid", Effect.map(pidIn("close-kills", shell, subject.folder, "close.pid"), (found) => { pid = found; return found > 0 }))
    yield* Scope.close(inner, Exit.void).pipe(bounded("close-kills", "the close of the shell's scope"))
    yield* until("close-kills", `after the shell's scope closed: the background process ${pid} the command started is gone`, gone("close-kills", shell, pid))
    yield* Fiber.interrupt(running)
  })],
]

/**
 * The `Shell` contract as checks (ADR 0028), each on a fresh shell: an exit code is read, 0 and not 0, neither a
 * failure (`exit`); stdout and stderr are each the command's, as UTF-8 (`output`); output over the bound keeps its end,
 * never half a character, and counts the bytes left out (`bounded`); a command starts in the folder given (`cwd`);
 * it sees the variables the shell was given and none other but those a shell sets itself (`environment`); a command
 * past its time ends `TimedOut` at once (`timeout`); and every process a command started, a `sleep` in the background,
 * is gone after a timeout (`timeout-kills`), after the command returned (`return-kills`), after its run was
 * interrupted (`interrupt-kills`) and after the shell's scope closed (`close-kills`). The kit runs `sh` commands
 * (`printf`, `yes`, `head`, `tr`, `env`, `pwd`, `sleep`, `kill`): a POSIX machine's.
 *
 * @public
 */
export const shellConformance = (subject: ShellSubject): ReadonlyArray<ConformanceCheck> =>
  checks(subject).map(([id, name, run]) => ({
    id,
    name,
    run: Effect.scoped(Effect.flatMap(subject.open, run)).pipe(
      Effect.timeoutOrElse({ duration: `${3 * PATIENCE_MS} millis`, orElse: () => fail(id, `the check did not end in ${3 * PATIENCE_MS / 1000} seconds`) }),
    ),
  }))

