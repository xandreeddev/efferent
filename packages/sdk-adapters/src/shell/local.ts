import { type ChildProcess, spawn } from "node:child_process"
import { Effect, FiberRef, Layer } from "effect"
import {
  RunContextRef,
  Shell,
  ShellAborted,
  ShellError,
  type ShellExecResult,
  ShellProcessNotFound,
  type ShellProcInfo,
  type ShellReadResult,
  ShellTimeout,
} from "@xandreed/sdk-core"

// Fallback cap when a caller omits `timeoutMs` (the Bash tool passes its own
// 5-min default; the verifier passes 30 min — see DEFAULT_BASH_TIMEOUT_MS and
// EFFERENT_VERIFY_TIMEOUT_MS). This only bites a caller that omits entirely.
const DEFAULT_EXEC_TIMEOUT_MS = 60_000
// After a timeout/abort SIGTERM, escalate to SIGKILL if the group hasn't died.
const KILL_GRACE_MS = 1_000
// After the bash process exits, wait this long for any final piped output to
// flush before settling — bounded, so a disowned grandchild holding the pipe
// can NEVER hang the call (the 41-minute-hang bug). We settle on bash's `exit`,
// not on pipe EOF.
const PIPE_DRAIN_GRACE_MS = 200
// Per-background-process rolling buffer cap; older chunks are dropped (and the
// cursor base advanced) past this so a chatty long-runner can't grow unbounded.
const BG_MAX_BYTES = 256_000

/**
 * Signal an entire process GROUP. With `detached: true` the child is its own
 * group leader (pgid === pid), so `process.kill(-pid, …)` reaches the child AND
 * every descendant — `script`/`setsid`/reparented orphans included. Killing only
 * the direct child (the old bug) left grandchildren alive holding the pipe fds.
 */
const killGroup = (pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void => {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone — nothing to do
  }
}

interface BgChunk {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

interface BgEntry {
  readonly id: string
  readonly command: string
  readonly conversationId: string | undefined
  readonly child: ChildProcess
  readonly pid: number | undefined
  readonly startedAt: number
  chunks: Array<BgChunk>
  /** Absolute index of `chunks[0]` (advances as old chunks are trimmed). */
  base: number
  bytes: number
  running: boolean
  exitCode: number | null
}

const appendChunk = (entry: BgEntry, stream: "stdout" | "stderr", text: string): void => {
  entry.chunks.push({ stream, text })
  entry.bytes += text.length
  while (entry.bytes > BG_MAX_BYTES && entry.chunks.length > 1) {
    const dropped = entry.chunks.shift()
    if (dropped === undefined) break
    entry.bytes -= dropped.text.length
    entry.base += 1
  }
}

export const LocalShellLive = Layer.effect(
  Shell,
  Effect.sync(() => {
    const registry = new Map<string, BgEntry>()
    let seq = 0

    const exec: Shell["Type"]["exec"] = ({ command, cwd, timeoutMs, signal }) =>
      Effect.tryPromise({
        try: () =>
          new Promise<ShellExecResult>((resolve, reject) => {
            const start = Date.now()
            const child = spawn("bash", ["-c", command], {
              cwd,
              detached: true, // own process group, so we can group-kill on timeout
              stdio: ["ignore", "pipe", "pipe"],
            })
            const pid = child.pid
            const outChunks: Array<Buffer> = []
            const errChunks: Array<Buffer> = []
            child.stdout?.on("data", (d: Buffer) => outChunks.push(d))
            child.stderr?.on("data", (d: Buffer) => errChunks.push(d))

            let timedOut = false
            let aborted = false
            let settled = false
            let hardTimer: ReturnType<typeof setTimeout> | undefined

            const timeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
            const escalate = () => {
              hardTimer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS)
            }
            const timer =
              timeout > 0
                ? setTimeout(() => {
                    timedOut = true
                    killGroup(pid, "SIGTERM")
                    escalate()
                  }, timeout)
                : undefined

            const onAbort = () => {
              aborted = true
              killGroup(pid, "SIGTERM")
              escalate()
            }
            if (signal !== undefined) {
              if (signal.aborted) onAbort()
              else signal.addEventListener("abort", onAbort)
            }

            const finish = (exitCode: number | null) => {
              if (settled) return
              settled = true
              if (timer !== undefined) clearTimeout(timer)
              if (hardTimer !== undefined) clearTimeout(hardTimer)
              if (signal !== undefined) signal.removeEventListener("abort", onAbort)
              if (timedOut) return reject(new ShellTimeout({ command, timeoutMs: timeout }))
              if (aborted) return reject(new ShellAborted({ command }))
              resolve({
                exitCode,
                stdout: Buffer.concat(outChunks).toString(),
                stderr: Buffer.concat(errChunks).toString(),
                durationMs: Date.now() - start,
                timedOut: false,
              })
            }

            // Settle on bash's EXIT (not pipe EOF) + a bounded drain grace, so an
            // orphaned grandchild holding the pipe can never hang us.
            child.on("exit", (code) => setTimeout(() => finish(code), PIPE_DRAIN_GRACE_MS))
            child.on("error", (err) => {
              if (settled) return
              settled = true
              if (timer !== undefined) clearTimeout(timer)
              if (signal !== undefined) signal.removeEventListener("abort", onAbort)
              reject(
                new ShellError({ cause: err, message: `shell spawn failed: ${err.message}` }),
              )
            })
          }),
        catch: (cause) => {
          if (cause instanceof ShellTimeout) return cause
          if (cause instanceof ShellAborted) return cause
          return new ShellError({
            cause,
            message: `shell command failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        },
      })

    const spawnBackground: Shell["Type"]["spawnBackground"] = ({
      command,
      cwd,
      conversationId,
    }) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        const onBg = rc.onBgOutput
        return yield* Effect.try({
          try: () => {
            const child = spawn("bash", ["-c", command], {
              cwd,
              detached: true, // outlives the tool call; killed by group on teardown
              stdio: ["ignore", "pipe", "pipe"],
            })
            const id = `bg_${++seq}`
            const entry: BgEntry = {
              id,
              command,
              conversationId,
              child,
              pid: child.pid,
              startedAt: Date.now(),
              chunks: [],
              base: 0,
              bytes: 0,
              running: true,
              exitCode: null,
            }
            registry.set(id, entry)
            const emit = (stream: "stdout" | "stderr", text: string) => {
              appendChunk(entry, stream, text)
              if (onBg !== undefined) {
                Effect.runFork(onBg({ processId: id, stream, chunk: text }))
              }
            }
            child.stdout?.on("data", (d: Buffer) => emit("stdout", d.toString()))
            child.stderr?.on("data", (d: Buffer) => emit("stderr", d.toString()))
            child.on("exit", (code) => {
              entry.running = false
              entry.exitCode = code
            })
            child.on("error", () => {
              entry.running = false
              if (entry.exitCode === null) entry.exitCode = -1
            })
            return { id, pid: child.pid ?? null }
          },
          catch: (cause) =>
            new ShellError({
              cause,
              message: `failed to start background process: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        })
      })

    const readBackground: Shell["Type"]["readBackground"] = ({ id, sinceCursor }) => {
      const entry = registry.get(id)
      if (entry === undefined) return Effect.fail(new ShellProcessNotFound({ id }))
      const since = sinceCursor ?? 0
      const startLocal = Math.max(0, since - entry.base)
      const slice = entry.chunks.slice(startLocal)
      const result: ShellReadResult = {
        stdout: slice.filter((c) => c.stream === "stdout").map((c) => c.text).join(""),
        stderr: slice.filter((c) => c.stream === "stderr").map((c) => c.text).join(""),
        exitCode: entry.exitCode,
        running: entry.running,
        cursor: entry.base + entry.chunks.length,
      }
      return Effect.succeed(result)
    }

    const killGroupWithGrace = (pid: number | undefined): void => {
      killGroup(pid, "SIGTERM")
      setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS)
    }

    const killBackground: Shell["Type"]["killBackground"] = (id) =>
      Effect.sync(() => {
        const entry = registry.get(id)
        if (entry === undefined) return { killed: false }
        killGroupWithGrace(entry.pid)
        entry.running = false
        return { killed: true }
      })

    const listBackground: Shell["Type"]["listBackground"] = (conversationId) =>
      Effect.sync(() => {
        const out: Array<ShellProcInfo> = []
        for (const e of registry.values()) {
          if (conversationId !== undefined && e.conversationId !== conversationId) continue
          out.push({
            id: e.id,
            command: e.command,
            running: e.running,
            startedAt: e.startedAt,
            pid: e.pid ?? null,
          })
        }
        return out
      })

    const killAllBackground: Shell["Type"]["killAllBackground"] = (conversationId) =>
      Effect.sync(() => {
        for (const [id, e] of registry) {
          if (conversationId !== undefined && e.conversationId !== conversationId) continue
          killGroupWithGrace(e.pid)
          e.running = false
          registry.delete(id)
        }
      })

    return {
      exec,
      spawnBackground,
      readBackground,
      killBackground,
      listBackground,
      killAllBackground,
    }
  }),
)
