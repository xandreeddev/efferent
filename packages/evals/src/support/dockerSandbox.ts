import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, realpathSync, symlinkSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { Effect, Layer } from "effect"
import { Shell } from "@efferent/sdk-core"

/**
 * Per-case Docker isolation so real-commit tasks (which let the agent run
 * arbitrary bash + execute tests) can run in PARALLEL without touching the host
 * or each other. The case's host temp dir is bind-mounted at `/work` in an
 * ephemeral `oven/bun` container with `--network none`; the agent's `Bash` and
 * the verify step run via `docker exec` inside it. File tools stay on the host
 * (the bind mount keeps both views consistent). Disjoint dirs → disjoint
 * containers → safe concurrency.
 */

const IMAGE = "oven/bun:latest"

/**
 * The repo's `node_modules`, mounted read-only at `/work/node_modules` so a
 * module that imports `effect` (etc.) resolves and runs in the otherwise
 * network-less container. The repo's symlinks are RELATIVE (`.bun/<pkg>@<ver>`),
 * so the whole tree resolves inside the mount.
 */
const REPO_ROOT = ((): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    return process.cwd()
  }
})()
const NODE_MODULES = join(REPO_ROOT, "node_modules")

/**
 * Ensure `node_modules/@effect` resolves, so a module that imports `@effect/ai`
 * (e.g. `agentLoop.ts`, pulled in by the headroom/loop cases) loads in the
 * container. `@effect/ai` is installed PER-PACKAGE (`packages/core/node_modules`)
 * and not hoisted to the root `node_modules` the sandbox mounts. We can't add a
 * nested bind mount (the root mount is read-only — Docker can't create the
 * mountpoint), so instead we point the root `node_modules/@effect` at the real
 * `.bun` scope dir with a RELATIVE symlink: the link lands at the package's real
 * depth, so `@effect/ai`'s own peer symlinks (`platform`/`experimental`/`rpc`)
 * keep resolving, and the ordinary `node_modules` mount carries it. Idempotent,
 * best-effort (a `bun install` may drop it; effect-only cases don't need it).
 */
const ensureEffectScopeLink = (): void => {
  const link = join(NODE_MODULES, "@effect")
  if (existsSync(link)) return
  try {
    const real = dirname(realpathSync(join(REPO_ROOT, "packages/core/node_modules/@effect/ai")))
    symlinkSync(relative(NODE_MODULES, real), link)
  } catch {
    /* effect-only cases are unaffected; @effect/ai cases will surface a clear load error */
  }
}

interface DockerResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const docker = (args: ReadonlyArray<string>, timeoutMs = 120_000): DockerResult => {
  const r = spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export interface Sandbox {
  readonly containerId: string
  /** Run a command inside the container at `/work`. Never throws. */
  readonly exec: (command: string, timeoutMs?: number) => DockerResult
}

/**
 * Acquire a container around `hostDir` for the duration of `use`, then remove
 * it (even on failure/interrupt). Runs as the host uid:gid so files written in
 * the container are owned correctly on the bind mount.
 */
export const withSandbox = <A, E, R>(
  hostDir: string,
  use: (sb: Sandbox) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: (): Sandbox => {
        ensureEffectScopeLink()
        const uid = process.getuid?.() ?? 1000
        const gid = process.getgid?.() ?? 1000
        const start = docker([
          "run",
          "-d",
          "--rm",
          "--network",
          "none",
          "--user",
          `${uid}:${gid}`,
          "-v",
          `${hostDir}:/work`,
          ...(existsSync(NODE_MODULES)
            ? ["-v", `${NODE_MODULES}:/work/node_modules:ro`]
            : []),
          "-w",
          "/work",
          IMAGE,
          "sleep",
          "900",
        ])
        const cid = start.stdout.trim()
        if (start.exitCode !== 0 || cid.length === 0) {
          throw new Error(`docker run failed: ${start.stderr || start.stdout}`)
        }
        return {
          containerId: cid,
          exec: (command, timeoutMs) =>
            docker(["exec", "-w", "/work", cid, "bash", "-lc", command], timeoutMs),
        }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    use,
    (sb) => Effect.sync(() => docker(["rm", "-f", sb.containerId], 30_000)),
  )

/**
 * A `Shell` whose `exec` runs inside the sandbox container. Provided over the
 * agent loop so its `Bash` tool is confined to the container (`cwd` collapses to
 * the `/work` mount — the agent's workspace-relative paths resolve there).
 */
export const dockerShellLayer = (sb: Sandbox): Layer.Layer<Shell> =>
  Layer.succeed(
    Shell,
    Shell.of({
      exec: ({ command, timeoutMs }) =>
        Effect.sync(() => {
          const start = Date.now()
          const r = sb.exec(command, timeoutMs)
          return {
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            durationMs: Date.now() - start,
            timedOut: false,
          }
        }),
    }),
  )
