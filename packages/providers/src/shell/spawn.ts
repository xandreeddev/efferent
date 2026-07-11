import { Effect } from "effect"
import { ShellError, ShellResult } from "@xandreed/engine"

/**
 * The ONE spawn path both shells share — hardened where the naive
 * `Bun.spawn` + `Response.text()` skeleton failed:
 *
 * - **Process-GROUP kill on timeout.** `Bun.spawn` has no `detached` and a
 *   child shares our process group (probed live), so a plain kill orphans
 *   grandchildren (`bash -c "sleep 100 &"` survived the old timeout). The
 *   command runs under `setsid` (its pid = its pgid) and the timeout kills
 *   `-pid` — the whole group dies. A timeout is a RESULT the model reads
 *   (exit 124-style note on stderr), never a silent 143.
 * - **Bounded INCREMENTAL capture.** `new Response(stream).text()` buffered
 *   everything — one `yes | head -c 1G` sank the run. Streams are read
 *   chunk-wise; past the cap the rest is DRAINED but discarded (the child
 *   never blocks on a full pipe) and the clip is noted in the text.
 *
 * `setsid` is util-linux — present on the Linux targets (dev + CI) this
 * line runs on.
 */

export const MAX_OUTPUT_BYTES = 262_144
const TRUNCATION_NOTE = `\n[…output truncated at ${Math.round(MAX_OUTPUT_BYTES / 1024)}KB…]`

interface Captured {
  readonly text: string
  readonly truncated: boolean
}

/** Chunk-wise read with a byte cap; past it, drain-and-discard (recursive —
 *  no loop statements; async recursion never grows the call stack). */
const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  capBytes: number,
  onChunk?: (chunk: string) => void,
): Promise<Captured> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const step = async (acc: {
    readonly text: string
    readonly bytes: number
    readonly truncated: boolean
  }): Promise<Captured> => {
    const { done, value } = await reader.read()
    if (done === true || value === undefined) {
      return {
        text: acc.truncated ? acc.text + TRUNCATION_NOTE : acc.text + decoder.decode(),
        truncated: acc.truncated,
      }
    }
    if (acc.truncated) return step(acc)
    const bytes = acc.bytes + value.byteLength
    // The chunk that CROSSES the cap is clipped to the allowed prefix — the
    // capture never exceeds the cap by more than a dangling code point.
    const kept = bytes > capBytes ? value.slice(0, capBytes - acc.bytes) : value
    const text = decoder.decode(kept, { stream: true })
    if (onChunk !== undefined && text.length > 0) onChunk(text)
    return step({
      text: acc.text + text,
      bytes,
      truncated: bytes > capBytes,
    })
  }
  return step({ text: "", bytes: 0, truncated: false })
}

const killGroup = (pid: number): void => {
  const attempt = Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(
    // The leader may already be gone; fall back to the direct child.
    Effect.orElse(() => Effect.try(() => process.kill(pid, "SIGKILL"))),
    Effect.ignore,
  )
  Effect.runSync(attempt)
}

/** PATH with a workspace's portable toolchain prefix (`<ws>/.local/bin`)
 *  in front — the ONE prefix the coder's shell AND the gates both see, so a
 *  self-provisioned tool (the zig run downloaded its own toolchain there)
 *  counts for the verdict, not just for self-verification. A non-existent
 *  entry is harmlessly skipped by the shell. */
export const workspacePath = (workspace: string): string =>
  `${workspace}/.local/bin:${process.env["PATH"] ?? ""}`

/**
 * Run `argv` in its OWN process group with bounded capture. A non-zero exit
 * — including our timeout kill — is a `ShellResult` the model reads; the
 * error channel carries only spawn infrastructure failures.
 */
export const spawnBounded = (
  argv: ReadonlyArray<string>,
  cwd: string | undefined,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
  env?: Record<string, string | undefined>,
): Effect.Effect<ShellResult, ShellError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["setsid", ...argv], {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
        stdout: "pipe",
        stderr: "pipe",
      })
      const fired = { current: false }
      const timer = setTimeout(() => {
        fired.current = true
        killGroup(proc.pid)
      }, timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(proc.stdout, MAX_OUTPUT_BYTES, onChunk),
        readCapped(proc.stderr, MAX_OUTPUT_BYTES, onChunk),
        proc.exited,
      ])
      clearTimeout(timer)
      return new ShellResult({
        stdout: stdout.text,
        stderr: fired.current
          ? `${stderr.text}\n[timed out after ${Math.round(timeoutMs / 1000)}s — the process group was killed]`
          : stderr.text,
        exitCode,
      })
    },
    catch: (e) => new ShellError({ message: String(e) }),
  })
