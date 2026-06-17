/**
 * Describe the *active* conversation store for `:settings` — what's actually
 * connected, not just what's in config.json. The store is selected at boot
 * from `EFFERENT_DB_URL` (an env var, or one seeded from config.json's `dbUrl`
 * by `seedDbUrlFromConfig`), so the live env value — not the persisted config —
 * is the source of truth. A pure function so it's unit-testable.
 */

import { maskDbUrl } from "@efferent/sdk-core"

export interface DbStatus {
  /** The headline line, e.g. `database: Postgres postgres://u:***@h/db  (active · from EFFERENT_DB_URL env)`. */
  readonly line: string
  /** A concise value for compact display (e.g. the settings modal row). */
  readonly value: string
  /** Present only when a config.json `dbUrl` is being overridden by the env var. */
  readonly overrideNote?: string
}

const isPostgres = (v: string): boolean => /^postgres(ql)?:\/\//i.test(v)
const sqlitePath = (v: string): string => v.replace(/^sqlite:(\/\/)?/i, "")

/**
 * Short storage label for the status bar. `pg` when EFFERENT_DB_URL is a
 * Postgres URL, else `sqlite` (a path, or the default when unset).
 */
export const storageLabel = (envDbUrl: string | undefined): "pg" | "sqlite" => {
  const v = envDbUrl?.trim()
  return v && v.length > 0 && isPostgres(v) ? "pg" : "sqlite"
}

export const describeActiveDatabase = (
  envDbUrl: string | undefined,
  configDbUrl: string | undefined,
): DbStatus => {
  const active = envDbUrl?.trim()
  const cfg = configDbUrl?.trim()

  const value =
    active && active.length > 0
      ? isPostgres(active)
        ? `Postgres ${maskDbUrl(active)}`
        : `SQLite ${sqlitePath(active)}`
      : "SQLite ~/.efferent/efferent.db"

  const line =
    active && active.length > 0
      ? `database: ${value}  (active · from ${cfg && cfg === active ? "config.json" : "EFFERENT_DB_URL env"})`
      : `database: ${value}  (active · default)`

  if (cfg && cfg.length > 0 && cfg !== (active ?? "")) {
    return {
      line,
      value,
      overrideNote: `  config.json dbUrl: ${maskDbUrl(cfg)} (overridden by EFFERENT_DB_URL env)`,
    }
  }
  return { line, value }
}
