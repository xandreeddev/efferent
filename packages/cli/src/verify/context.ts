import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Shared run context threaded through the tiers. The cheap model is the default
 * for BOTH the agent-under-test (Tier B) and the judge (Tier C) — overridable
 * with `--model`. `hasKey` gates the keyed tiers so they `skip` cleanly with no
 * credential rather than fail.
 */

export const DEFAULT_VERIFY_MODEL = "opencode:deepseek-v4-flash"

export interface VerifyCtx {
  readonly model: string
  readonly hasKey: boolean
  /** Repo root for the UI-flow bun tests + the evals bridge (source/commit only). */
  readonly repoRoot: string | undefined
  /** Promote Tier C soft-fails (and other softs) to hard fails. */
  readonly strict: boolean
}

const authPath = (): string =>
  process.env.EFFERENT_HOME
    ? join(process.env.EFFERENT_HOME, ".efferent", "auth.json")
    : join(homedir(), ".efferent", "auth.json")

/** True iff the resolved efferent home holds ≥1 provider credential. Reads the
 *  same `auth.json` the AuthStore does — no env-var keys (that path is CI-only). */
export const hasCredential = (): boolean => {
  const path = authPath()
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.keys(parsed as Record<string, unknown>).length > 0
    )
  } catch {
    return false
  }
}
