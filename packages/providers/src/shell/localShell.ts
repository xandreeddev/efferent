import { Effect, Layer } from "effect"
import { Shell, ShellError, ShellResult } from "@xandreed/engine"

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/**
 * Subprocess execution via `Bun.spawn` (`bash -c`). A non-zero exit is a
 * RESULT the model reads; the error channel carries only spawn/timeout
 * infrastructure failures.
 */
export const LocalShellLive = Layer.succeed(Shell, {
  exec: (command: string, options?: { readonly cwd?: string; readonly timeoutMs?: number }) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["bash", "-c", command], {
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
          stdout: "pipe",
          stderr: "pipe",
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return new ShellResult({ stdout, stderr, exitCode })
      },
      catch: (e) => new ShellError({ message: String(e) }),
    }),
})
