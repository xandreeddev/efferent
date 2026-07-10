import { Layer } from "effect"
import { Shell } from "@xandreed/engine"
import { spawnBounded } from "./spawn.js"

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/**
 * Subprocess execution over the shared hardened spawn (`bash -c` in its own
 * process group, bounded incremental capture — see `spawn.ts`). A non-zero
 * exit is a RESULT the model reads; the error channel carries only spawn
 * infrastructure failures.
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
    ),
})
