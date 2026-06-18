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
