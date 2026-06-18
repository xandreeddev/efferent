import { maskDbUrl } from "./Settings.js"

/**
 * A configured database connection. `url` is a SQLite file path (optionally
 * `sqlite:`-prefixed) for `kind: "sqlite"`, or a `postgres://…` connection string
 * for `kind: "postgres"`. Pure value — the adapter turns it into a live store.
 */
export type DbKind = "sqlite" | "postgres"

export interface DatabaseConn {
  readonly kind: DbKind
  readonly url: string
}

/** A connection plus its user-facing name (the key in `Settings.databases`). */
export interface NamedConn extends DatabaseConn {
  readonly name: string
}

/** The always-present implicit connection: zero-config local SQLite. */
export const LOCAL_DB_NAME = "local"

/** Postgres iff the value looks like a `postgres://…` / `postgresql://…` URL. */
export const kindFromUrl = (url: string): DbKind =>
  /^postgres(ql)?:\/\//i.test(url.trim()) ? "postgres" : "sqlite"

export const connFromUrl = (url: string): DatabaseConn => ({
  kind: kindFromUrl(url),
  url: url.trim(),
})

/** Short kind tag for chips/labels. */
export const kindTag = (kind: DbKind): string => (kind === "postgres" ? "pg" : "sqlite")

/** A connection's value with any Postgres password masked (display/logs/OPSEC). */
export const maskConn = (c: DatabaseConn): string =>
  c.kind === "postgres" ? maskDbUrl(c.url) : c.url

/** `<name> (pg)` / `<name> (sqlite)` — the status-bar + picker label. */
export const connLabel = (name: string, kind: DbKind): string => `${name} (${kindTag(kind)})`

/** A fresh, unique name for a newly-added connection (auto-named like the
 *  provider keys — `remote`, `remote-2`, … / `local-2`). */
export const suggestName = (conn: DatabaseConn, existing: ReadonlyArray<string>): string => {
  const base = conn.kind === "postgres" ? "remote" : "local"
  if (!existing.includes(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!existing.includes(candidate)) return candidate
  }
}

/**
 * The full list of configured connections for a settings snapshot: the implicit
 * zero-config **local** SQLite first, then every named entry in `databases`. The
 * active one is `defaultDatabase` (falling back to `local`).
 */
export const configuredConns = (
  databases: Record<string, DatabaseConn> | undefined,
  localUrl: string,
): ReadonlyArray<NamedConn> => {
  const named = Object.entries(databases ?? {}).map(([name, c]) => ({ name, kind: c.kind, url: c.url }))
  const hasLocal = named.some((c) => c.name === LOCAL_DB_NAME)
  return hasLocal ? named : [{ name: LOCAL_DB_NAME, kind: "sqlite", url: localUrl }, ...named]
}

/** The active connection name for a settings snapshot (default ⇒ `local`). */
export const activeConnName = (defaultDatabase: string | undefined): string =>
  defaultDatabase ?? LOCAL_DB_NAME

