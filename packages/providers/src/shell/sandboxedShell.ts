import { Effect, Layer } from "effect"
import { Shell, ShellError, ShellResult } from "@xandreed/engine"

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/**
 * The coder's Bash, sandboxed with bubblewrap: the WORKSPACE is bind-mounted
 * read-write, everything else read-only, /tmp a fresh tmpfs, HOME redirected
 * into it, `--die-with-parent` so nothing outlives the run. Network stays ON
 * (installs and test runs need it). Zero-daemon by design — and when `bwrap`
 * is absent, the layer degrades to the plain shell with ONE loud stderr
 * warning (never silently sandboxless: the warning is the contract).
 *
 * Scope: this layer is provided to the CODER's toolkit only. The gates run
 * the human's own check commands unsandboxed, and `:ship` needs the real
 * HOME (gh/ssh credentials) — both deliberately stay on `LocalShellLive`.
 */

/** The bwrap invocation, exported for tests: workspace rw, / ro, fresh /tmp
 *  + scratch HOME, no new privileges. */
export const bwrapArgs = (
  workspace: string,
  chdir: string,
  command: string,
): ReadonlyArray<string> => [
  "bwrap",
  "--die-with-parent",
  "--unshare-pid",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--tmpfs",
  "/tmp",
  "--dir",
  "/tmp/home",
  "--setenv",
  "HOME",
  "/tmp/home",
  "--bind",
  workspace,
  workspace,
  "--chdir",
  chdir,
  "bash",
  "-c",
  command,
]

const run = (
  argv: ReadonlyArray<string>,
  cwd: string | undefined,
  timeoutMs: number,
): Effect.Effect<ShellResult, ShellError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...argv], {
        ...(cwd !== undefined ? { cwd } : {}),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return new ShellResult({ stdout, stderr, exitCode })
    },
    catch: (e) => new ShellError({ message: String(e) }),
  })

/** One probe at layer build — is bwrap present AND able to sandbox here? */
const probe: Effect.Effect<boolean> = run(
  ["bwrap", "--ro-bind", "/", "/", "true"],
  undefined,
  10_000,
).pipe(
  Effect.map((result) => result.exitCode === 0),
  Effect.orElseSucceed(() => false),
)

export const SandboxedShellLive = (workspace: string): Layer.Layer<Shell> =>
  Layer.effect(
    Shell,
    Effect.gen(function* () {
      const sandboxed = yield* probe
      yield* sandboxed
        ? Effect.void
        : Effect.sync(() => {
            console.error(
              "smith: bwrap is not available — the coder's Bash runs UNSANDBOXED (install bubblewrap to isolate it)",
            )
          })
      yield* Effect.annotateCurrentSpan({ sandbox: sandboxed ? "bwrap" : "off" })
      return {
        exec: (
          command: string,
          options?: { readonly cwd?: string; readonly timeoutMs?: number },
        ) =>
          run(
            sandboxed
              ? bwrapArgs(workspace, options?.cwd ?? workspace, command)
              : ["bash", "-c", command],
            sandboxed ? undefined : (options?.cwd ?? workspace),
            options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ),
      }
    }),
  )
