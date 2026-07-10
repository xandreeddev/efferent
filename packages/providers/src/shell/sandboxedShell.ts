import { Effect, Layer } from "effect"
import { Shell } from "@xandreed/engine"
import { spawnBounded } from "./spawn.js"

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

/** One probe at layer build — is bwrap present AND able to sandbox here?
 *  Rides the same hardened spawn as the real calls (group kill included:
 *  `--unshare-pid` makes bwrap the namespace init, so killing its group
 *  takes the whole sandbox down with it). */
const probe: Effect.Effect<boolean> = spawnBounded(
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
          spawnBounded(
            sandboxed
              ? bwrapArgs(workspace, options?.cwd ?? workspace, command)
              : ["bash", "-c", command],
            sandboxed ? undefined : (options?.cwd ?? workspace),
            options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ),
      }
    }),
  )
