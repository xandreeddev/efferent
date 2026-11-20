import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { access, constants, lstat, readlink, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { Deferred, Effect, Layer, Option, Result } from "effect"
import { Shell, ShellRefused, ShellUnavailable } from "@xandreed/sdk"
import type { Ran, RunRequest } from "@xandreed/sdk"
import { SANDBOX_DEFAULTS, SandboxUnavailable, ETC_ALWAYS, ETC_NETWORK, SYSTEM_TOP } from "./sandbox.entity.js"
import type { HostEntry, HostLayout, Limits, SandboxPlan, ToolBind } from "./sandbox.entity.js"
import { bwrapArgv, innerCwdOf, keptOf, probeArgv, tailOf, toolBindOf } from "./sandbox.entity.functions.js"
import { Sandboxes } from "./sandboxes.port.js"

/** A foreign failure's words: its own message when it is an `Error`. */
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : "no reason given"

/** How long the pipes are read after a sandbox ended, when something still holds them. */
const CLOSE_GRACE_MS = 2_000

/** The tools bound into every sandbox when the host has them; npm and npx come with node. */
export const TOOLS = ["bun", "node", "pnpm", "yarn"] as const

/** Whether the host has `path` (with `mode`, existence by default); a failure to look is a no. */
const exists = (path: string, mode: number = constants.F_OK) => Effect.tryPromise(() => access(path, mode)).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))

/** The first executable named `name` in the folders of a `PATH`, if any. */
const onPath = (name: string, path: string) => Effect.gen(function* () {
  for (const folder of path.split(":").filter((entry) => isAbsolute(entry))) {
    const candidate = join(folder, name)
    if (yield* exists(candidate, constants.X_OK)) return Option.some(candidate)
  }
  return Option.none<string>()
})

/** A tool found on the host's `PATH`, by its real path, with the folders that say how it is bound (`toolBindOf`). */
const toolOf = (name: string, path: string) => Effect.gen(function* () {
  const found = yield* onPath(name, path)
  if (Option.isNone(found)) return []
  const real = yield* Effect.tryPromise(() => realpath(found.value)).pipe(Effect.option)
  if (Option.isNone(real)) return []
  const binDir = dirname(real.value)
  const parent = dirname(binDir)
  const isNode = name === "node" && basename(binDir) === "bin" && (yield* exists(join(parent, "lib", "node_modules", "npm")))
  const inPackage = !isNode && basename(binDir) === "bin" && (yield* exists(join(parent, "package.json")))
  const tools = join(binDir, ".tools")
  return toolBindOf({
    name,
    real: real.value,
    prefix: isNode ? Option.some(parent) : Option.none(),
    packageRoot: inPackage ? Option.some(parent) : Option.none(),
    toolsDir: !isNode && !inPackage && (yield* exists(tools)) ? Option.some(tools) : Option.none(),
  })
})

/** A top-level system path as the host has it: a link, a folder, or none. */
const topOf = (path: string) => Effect.tryPromise(() => lstat(path)).pipe(
  Effect.flatMap((info) => info.isSymbolicLink()
    ? Effect.map(Effect.tryPromise(() => readlink(path)), (target): Option.Option<HostEntry> => Option.some({ _tag: "Link", path, target }))
    : Effect.succeed<Option.Option<HostEntry>>(info.isDirectory() ? Option.some({ _tag: "Folder", path }) : Option.none())),
  Effect.catch(() => Effect.succeed(Option.none<HostEntry>())),
)

/** An `/etc` path the host has, with its real path: `/etc/resolv.conf` is often a link into `/run`. */
const etcOf = (path: string) => Effect.tryPromise(() => realpath(path)).pipe(
  Effect.map((real) => Option.some({ path, real })),
  Effect.catch(() => Effect.succeed(Option.none<{ readonly path: string; readonly real: string }>())),
)

/** Run `bwrap` once with `args`, its environment empty, and answer its exit code and stderr. */
const bwrapOnce = (bwrap: string, args: ReadonlyArray<string>) => Effect.callback<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((resume) => {
  execFile(bwrap, [...args], { env: {}, timeout: 10_000 }, (error, stdout, stderr) => {
    resume(Effect.succeed({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout: String(stdout), stderr: String(stderr).trim() }))
  })
})

/**
 * This host's side of a sandbox, checked: `bwrap` (the first on `path`, the host's), the system's top
 * folders, the `/etc` files there are, and the toolchain (`TOOLS`) found on `path` by real path. Then one probe:
 * `bwrap --unshare-all` running `true`. No `bwrap`, or a probe the system refuses (user namespaces off, or AppArmor
 * restricting them), is `SandboxUnavailable` with the reason.
 */
export const bwrapHost = Effect.fn("bwrap.host")(function* (path: string) {
  const bwrap = yield* onPath("bwrap", path)
  if (Option.isNone(bwrap)) return yield* Effect.fail(new SandboxUnavailable({ reason: "no-bwrap", message: "bwrap (bubblewrap) is not installed on this host, so nothing of a pull request's runs" }))
  const top = (yield* Effect.forEach(SYSTEM_TOP, topOf, { concurrency: 1 })).flatMap(Option.toArray)
  const etc = (yield* Effect.forEach([...ETC_ALWAYS, ...ETC_NETWORK], etcOf, { concurrency: 1 })).flatMap(Option.toArray)
  const tools: ReadonlyArray<ToolBind> = (yield* Effect.forEach(TOOLS, (name) => toolOf(name, path), { concurrency: 1 })).flat()
  const help = yield* bwrapOnce(bwrap.value, ["--help"])
  const layout: HostLayout = { bwrap: bwrap.value, tmpfsSize: help.stdout.includes("--size"), top, etc, tools }
  const probe = yield* bwrapOnce(layout.bwrap, probeArgv(layout))
  if (probe.code !== 0) return yield* Effect.fail(new SandboxUnavailable({ reason: "namespaces", message: `bwrap cannot make a sandbox on this host (${probe.stderr || `exit ${probe.code}`}); unprivileged user namespaces must be allowed` }))
  return layout
})

/**
 * Stop a sandbox: `bwrap` was spawned detached, so it leads a process group of its own; `SIGKILL` to the group stops
 * it, and with it the sandbox (`--die-with-parent`, and its pid namespace, whose every process the kernel stops when
 * the namespace's first process ends, those that called `setsid` too).
 */
const killGroup = (child: ChildProcess): void => {
  const pid = child.pid
  if (pid !== undefined) Result.try(() => process.kill(-pid, "SIGKILL"))
}

interface Held {
  chunks: ReadonlyArray<Uint8Array>
  dropped: number
}

/** How a sandbox is run: the host's layout, the plan, and each command's default time, bounds and output kept. */
export interface BwrapShellOptions {
  readonly layout: HostLayout
  readonly plan: SandboxPlan
  readonly timeoutMs?: number
  readonly limits?: Limits
  readonly outputBytes?: number
}

/**
 * A `Shell` whose every command runs in a sandbox of its own: `bwrap` spawned directly (never through a host shell),
 * with an empty environment, its arguments `bwrapArgv` (every namespace unshared, the network only when the plan
 * shares it, `/work` the only writable bind but the plan's), the command handed to the sandbox's shell as an argument.
 * A starting folder outside the work folder is `ShellRefused`. A run ends, however it ends, by stopping the sandbox
 * with every process in it; so does the scope's close. Each of stdout and stderr keeps its last `outputBytes` bytes.
 */
export const bwrapShell = Effect.fn("bwrap.shell")(function* (options: BwrapShellOptions) {
  const outputBytes = options.outputBytes ?? SANDBOX_DEFAULTS.outputBytes
  const defaultTimeout = options.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs
  const limits = options.limits ?? SANDBOX_DEFAULTS.limits
  const running = new Set<ChildProcess>()
  yield* Effect.addFinalizer(() => Effect.sync(() => running.forEach(killGroup)))

  const run = Effect.fn("bwrap.run")(function* (request: RunRequest) {
    const cwd = innerCwdOf(options.plan.workDir, Option.fromNullishOr(request.cwd))
    if (Result.isFailure(cwd)) return yield* Effect.fail(new ShellRefused({ reason: cwd.failure, message: `declined: ${cwd.failure}` }))
    yield* Effect.tryPromise({ try: () => stat(options.plan.workDir), catch: (cause) => new ShellUnavailable({ message: `the work folder ${options.plan.workDir} cannot be used: ${messageOf(cause)}` }) })
    const args = bwrapArgv(options.layout, options.plan, cwd.success, request.command, limits)
    const timeoutMs = request.timeoutMs ?? defaultTimeout
    const exited = yield* Deferred.make<{ readonly code: number | null; readonly signal: string | null }, ShellUnavailable>()
    const closed = yield* Deferred.make<void>()
    const out: Held = { chunks: [], dropped: 0 }
    const err: Held = { chunks: [], dropped: 0 }
    let stopped = false
    const keep = (held: Held) => (chunk: Uint8Array) => {
      const kept = keptOf([...held.chunks, chunk], outputBytes)
      held.chunks = kept.chunks
      held.dropped += kept.dropped
    }
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const child = spawn(options.layout.bwrap, [...args], { env: {}, detached: true, stdio: ["ignore", "pipe", "pipe"] })
          child.stdout?.on("data", keep(out))
          child.stderr?.on("data", keep(err))
          child.once("error", (cause) => Deferred.doneUnsafe(exited, Effect.fail(new ShellUnavailable({ message: `bwrap could not be started: ${messageOf(cause)}` }))))
          child.once("exit", (code, signal) => Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })))
          child.once("close", () => Deferred.doneUnsafe(closed, Effect.void))
          running.add(child)
          return child
        },
        catch: (cause) => new ShellUnavailable({ message: `bwrap could not be started: ${messageOf(cause)}` }),
      }),
      (child) => Effect.gen(function* () {
        const inTime = yield* Effect.timeoutOption(Deferred.await(exited), timeoutMs)
        if (Option.isNone(inTime)) killGroup(child)
        const exit = Option.isSome(inTime) ? inTime.value : yield* Deferred.await(exited)
        killGroup(child)
        running.delete(child)
        stopped = true
        const drained = yield* Effect.timeoutOption(Deferred.await(closed), CLOSE_GRACE_MS)
        if (Option.isNone(drained)) {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        const stdout = tailOf(out.chunks, outputBytes)
        const stderr = tailOf(err.chunks, outputBytes)
        const ran: Ran = {
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutCut: out.dropped + stdout.cut,
          stderrCut: err.dropped + stderr.cut,
          ended: Option.isNone(inTime)
            ? { _tag: "TimedOut", afterMs: timeoutMs }
            : exit.signal !== null ? { _tag: "Killed", signal: exit.signal } : { _tag: "Exited", code: exit.code ?? 0 },
        }
        return ran
      }),
      (child) => Effect.sync(() => {
        if (!stopped) killGroup(child)
        running.delete(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
      }),
    )
  })
  return Shell.of({ run })
})

/** The host's `PATH` read for `bwrap` and the toolchain, and the bounds every sandbox's commands run under. */
export interface BwrapSandboxesOptions {
  readonly path: string
  readonly limits?: Limits
  readonly outputBytes?: number
}

/**
 * Sandboxes through bubblewrap: the host checked once as the layer is built (`bwrapHost`; `SandboxUnavailable` when it
 * cannot make one), then a `bwrapShell` for each plan asked for.
 */
export const bwrapSandboxes = (options: BwrapSandboxesOptions): Layer.Layer<Sandboxes, SandboxUnavailable> => Layer.effect(Sandboxes, Effect.gen(function* () {
  const layout = yield* bwrapHost(options.path)
  return Sandboxes.of({
    tools: layout.tools.map((tool) => tool.name),
    shell: (plan) => bwrapShell({ layout, plan, ...(options.limits === undefined ? {} : { limits: options.limits }), ...(options.outputBytes === undefined ? {} : { outputBytes: options.outputBytes }) }),
  })
}))
