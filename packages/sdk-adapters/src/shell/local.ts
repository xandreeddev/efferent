import { Effect, Layer } from "effect"
import { Shell, ShellAborted, ShellError, ShellTimeout } from "@efferent/sdk-core"

interface SpawnLike {
  spawn: (cmd: string[], opts: {
    cwd: string
    stdout: "pipe"
    stderr: "pipe"
    stdin: "ignore"
    env?: Record<string, string | undefined>
  }) => {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill: (signal?: number | string) => void
  }
}

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const combined = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    combined.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(combined)
}

export const LocalShellLive = Layer.succeed(Shell, {
  exec: ({ command, cwd, timeoutMs, signal }) =>
    Effect.tryPromise({
      try: async () => {
        const start = Date.now()
        const bun = Bun as unknown as SpawnLike
        const proc = bun.spawn(["bash", "-c", command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        })

        let timedOut = false
        let aborted = false
        const timeout = timeoutMs ?? 60_000
        const timer =
          timeout > 0
            ? setTimeout(() => {
                timedOut = true
                proc.kill("SIGTERM")
                setTimeout(() => proc.kill("SIGKILL"), 1_000)
              }, timeout)
            : undefined

        const onAbort = () => {
          aborted = true
          proc.kill("SIGTERM")
        }
        if (signal !== undefined) {
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort)
        }

        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            readAll(proc.stdout),
            readAll(proc.stderr),
            proc.exited,
          ])
          if (timedOut) {
            throw new ShellTimeout({ command, timeoutMs: timeout })
          }
          if (aborted) {
            throw new ShellAborted({ command })
          }
          return {
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - start,
            timedOut: false,
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          if (signal !== undefined) signal.removeEventListener("abort", onAbort)
        }
      },
      catch: (cause) => {
        if (cause instanceof ShellTimeout) return cause
        if (cause instanceof ShellAborted) return cause
        return new ShellError({
          cause,
          message: `shell command failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      },
    }),
})
