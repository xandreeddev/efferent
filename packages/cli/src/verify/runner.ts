import { Effect } from "effect"

/**
 * A `Runner` is the single seam every verify tier is written against: it knows
 * how to *invoke the CLI under test* and where its scratch workspace lives. Only
 * `invoke`/`spawnBg` change between targets (a local `bun main.ts` spawn for the
 * `source`/`commit` targets; the `release`/`npm` clean-room runs a different,
 * container-native battery — see target.ts), so the tier checks stay identical.
 */

export interface InvokeResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
}

export interface InvokeOpts {
  /** Merged OVER process.env. */
  readonly env?: Record<string, string>
  readonly cwd?: string
  /** Written to the child's stdin, then closed. */
  readonly stdin?: string
  /** Kill + flag `timedOut` after this many ms (default 120s). */
  readonly timeoutMs?: number
}

/** A live background child (the daemon, or a held-open `--mode rpc` session). */
export interface BgHandle {
  /** Append to the child's stdin (it must have been spawned with a pipe). */
  readonly write: (s: string) => void
  /** All stdout captured so far. */
  readonly output: () => string
  readonly kill: () => void
  readonly exited: Promise<number>
}

export interface Runner {
  readonly invoke: (args: ReadonlyArray<string>, opts?: InvokeOpts) => Effect.Effect<InvokeResult>
  readonly spawnBg: (args: ReadonlyArray<string>, opts?: InvokeOpts) => Effect.Effect<BgHandle>
  /** A fresh temp project the agent acts in (proof files land here). */
  readonly workspaceDir: string
  /** Hermetic `EFFERENT_HOME` for the no-key tiers (isolated auth/db/discovery). */
  readonly homeDir: string
  /** Source/commit only — can run the `testRender` bun-test UI flows. */
  readonly supportsInProcess: boolean
  readonly cleanup: Effect.Effect<void>
}

const mergeEnv = (env?: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  return { ...base, ...(env ?? {}) }
}

/**
 * Build a local runner that invokes `bun <entry> …` — the working tree's
 * `main.ts` (source) or a worktree's (commit). `workspaceDir`/`homeDir` are
 * caller-owned temp dirs; `cleanup` is the caller's (target.ts owns teardown).
 */
export const makeLocalRunner = (input: {
  readonly entry: string
  readonly workspaceDir: string
  readonly homeDir: string
  readonly cleanup?: Effect.Effect<void>
}): Runner => {
  const argv = (args: ReadonlyArray<string>): string[] => [process.execPath, input.entry, ...args]

  const invoke: Runner["invoke"] = (args, opts = {}) =>
    Effect.tryPromise(async () => {
      const proc = Bun.spawn(argv(args), {
        cwd: opts.cwd ?? input.workspaceDir,
        env: mergeEnv(opts.env),
        stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const timeoutMs = opts.timeoutMs ?? 120_000
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(timer)
      return { stdout, stderr, exitCode, timedOut }
    }).pipe(
      Effect.orElseSucceed(() => ({
        stdout: "",
        stderr: "spawn failed",
        exitCode: 127,
        timedOut: false,
      })),
    )

  const spawnBg: Runner["spawnBg"] = (args, opts = {}) =>
    Effect.sync(() => {
      const proc = Bun.spawn(argv(args), {
        cwd: opts.cwd ?? input.workspaceDir,
        env: mergeEnv(opts.env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      let buf = ""
      // Pump stdout into a buffer the poller reads. Best-effort; errors end it.
      void (async () => {
        const reader = proc.stdout.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
          if (done) break
          if (value) buf += dec.decode(value, { stream: true })
        }
      })()
      return {
        write: (s: string) => {
          proc.stdin.write(s)
          proc.stdin.flush()
        },
        output: () => buf,
        kill: () => proc.kill(),
        exited: proc.exited,
      }
    })

  return {
    invoke,
    spawnBg,
    workspaceDir: input.workspaceDir,
    homeDir: input.homeDir,
    supportsInProcess: true,
    cleanup: input.cleanup ?? Effect.void,
  }
}
