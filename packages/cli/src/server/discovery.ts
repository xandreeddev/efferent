import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"

/**
 * The daemon **discovery file** — how a client finds (or decides to spawn) the
 * per-workspace daemon, tmux-style. One file per workspace under the efferent
 * home (honouring `EFFERENT_HOME`), named by a hash of the resolved workspace
 * dir: `~/.efferent/daemon-<hash>.json` = `{ port, pid, version, workspace }`.
 *
 * Lifecycle: the daemon writes it on start and removes it on graceful shutdown.
 * A stale file whose `/health` fails is treated as absent (the client re-spawns).
 */

export const DiscoveryInfo = Schema.Struct({
  port: Schema.Number,
  pid: Schema.Number,
  version: Schema.String,
  workspace: Schema.String,
})
export type DiscoveryInfo = typeof DiscoveryInfo.Type

const efferentHome = (): string =>
  process.env.EFFERENT_HOME ?? join(homedir(), ".efferent")

/** Stable short hash of the resolved workspace dir — the per-workspace key. */
export const workspaceHash = (workspace: string): string =>
  createHash("sha256").update(workspace).digest("hex").slice(0, 16)

export const discoveryPath = (workspace: string): string =>
  join(efferentHome(), `daemon-${workspaceHash(workspace)}.json`)

const decode = Schema.decodeUnknownOption(DiscoveryInfo)

/** Write the discovery file (creating the home dir). Best-effort/sync. */
export const writeDiscovery = (info: DiscoveryInfo): Effect.Effect<void> =>
  Effect.sync(() => {
    const path = discoveryPath(info.workspace)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(info), { encoding: "utf8" })
  })

/** Read + validate the discovery file for a workspace, or undefined if absent/garbage. */
export const readDiscovery = (
  workspace: string,
): Effect.Effect<DiscoveryInfo | undefined> =>
  Effect.sync(() => {
    const path = discoveryPath(workspace)
    if (!existsSync(path)) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return undefined
    }
    const decoded = decode(parsed)
    return decoded._tag === "Some" ? decoded.value : undefined
  })

/** Remove the discovery file (graceful shutdown / a confirmed-dead daemon). */
export const removeDiscovery = (workspace: string): Effect.Effect<void> =>
  Effect.sync(() => rmSync(discoveryPath(workspace), { force: true }))
