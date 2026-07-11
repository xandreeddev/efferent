import { Layer } from "effect"
import { Shell } from "@xandreed/engine"
import { spawnBounded, workspacePath } from "./spawn.js"

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/**
 * Subprocess execution over the shared hardened spawn (`bash -c` in its own
 * process group, bounded incremental capture — see `spawn.ts`). A non-zero
 * exit is a RESULT the model reads; the error channel carries only spawn
 * infrastructure failures. Commands see the call cwd's `.local/bin` first
 * on PATH — the portable toolchain prefix (parity with the sandboxed shell
 * and the gates; a missing dir is skipped by the shell).
 */
export const LocalShellLive = Layer.succeed(Shell, {
  exec: (
    command: string,
    options?: {
      readonly cwd?: string
      readonly timeoutMs?: number
      readonly onChunk?: (chunk: string) => void
    },
  ) =>
    spawnBounded(
      ["bash", "-c", command],
      options?.cwd,
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options?.onChunk,
      options?.cwd !== undefined ? { PATH: workspacePath(options.cwd) } : undefined,
    ),
})
