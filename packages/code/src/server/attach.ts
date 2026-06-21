import { Effect } from "effect"
import { WorkspaceError } from "@xandreed/sdk-core"
import { readDiscovery, type DiscoveryInfo } from "./discovery.js"

/**
 * Client-side **attach-or-spawn** — the transparent lifecycle the plan calls
 * for: a client reads the discovery file, attaches if a healthy daemon is
 * there, and spawns a detached one if not (then polls until it's up). Detaching
 * later just drops the connection; the daemon (and any running fleet) lives on.
 */

export const baseUrlOf = (info: DiscoveryInfo): string =>
  `http://127.0.0.1:${info.port}`

/** A `GET /health` probe — true on a 2xx, false on any error/timeout. */
export const probeHealth = (baseUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok),
  ).pipe(Effect.orElseSucceed(() => false))

/** Spawn a detached `daemon-serve` for `workspace` that outlives this client.
 *  Bun subprocess + `.unref()` so the client can exit while the daemon runs. */
export const spawnDetachedDaemon = (workspace: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const entry = process.argv[1] ?? "efferent"
    const proc = Bun.spawn([process.execPath, entry, "--mode", "daemon-serve", "--cwd", workspace], {
      cwd: workspace,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    })
    proc.unref()
  })

/**
 * Attach to the workspace's daemon, spawning one if absent/stale. Returns the
 * base URL to point a remote Workspace at. `spawnDaemon` is injectable so tests
 * drive an in-process daemon instead of a subprocess.
 */
export const attachOrSpawn = (
  workspace: string,
  opts: {
    readonly spawnDaemon?: (workspace: string) => Effect.Effect<void>
    readonly timeoutMs?: number
    readonly pollMs?: number
  } = {},
): Effect.Effect<{ readonly baseUrl: string }, WorkspaceError> =>
  Effect.gen(function* () {
    // A live daemon already registered → attach.
    const existing = yield* readDiscovery(workspace)
    if (existing !== undefined && (yield* probeHealth(baseUrlOf(existing)))) {
      return { baseUrl: baseUrlOf(existing) }
    }

    // Absent or stale (health failed) → spawn one and wait for it to register.
    const spawn = opts.spawnDaemon ?? spawnDetachedDaemon
    yield* spawn(workspace)

    const pollMs = opts.pollMs ?? 100
    const timeoutMs = opts.timeoutMs ?? 10_000
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs))
    let attempt = 0
    while (attempt < maxAttempts) {
      yield* Effect.sleep(`${pollMs} millis`)
      const info = yield* readDiscovery(workspace)
      if (info !== undefined && (yield* probeHealth(baseUrlOf(info)))) {
        return { baseUrl: baseUrlOf(info) }
      }
      attempt += 1
    }
    return yield* Effect.fail(
      new WorkspaceError({
        message: `daemon for ${workspace} did not come up within ${timeoutMs}ms`,
      }),
    )
  })
