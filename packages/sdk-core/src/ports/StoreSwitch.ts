import { Context, Data, type Effect } from "effect"
import type { DatabaseConn, DbKind } from "../entities/Database.js"
import type { ConversationId } from "../entities/Conversation.js"

export class StoreSwitchError extends Data.TaggedError("StoreSwitchError")<{
  readonly message: string
}> {}

/** The active database, for display (status bar) + decisions. */
export interface ActiveDb {
  readonly name: string
  readonly kind: DbKind
}

/** A workspace conversation summary (mirrors ConversationStore.listByWorkspace). */
export interface ConvSummary {
  readonly id: ConversationId
  readonly createdAt: number
  readonly firstPrompt?: string
  readonly title?: string
}

/** Outcome of connecting to / switching the active store. */
export interface SwitchResult {
  /** Conversations already present for the current workspace — 0 ⇒ a fresh DB. */
  readonly conversationCount: number
}

/**
 * Runtime control over the active conversation/context store. The store itself is
 * a `Ref`-backed facade (see `SwitchableStoresLive`): `switchTo` rebuilds it
 * against a new connection (running only *pending* migrations) and swaps it in
 * with no restart; `listSessions` builds a short-lived store to read ANOTHER
 * database's conversations without disturbing the active one (the sessions
 * browser). `current` names the active connection for the status bar.
 */
export class StoreSwitch extends Context.Tag("@xandreed/sdk-core/StoreSwitch")<
  StoreSwitch,
  {
    readonly current: Effect.Effect<ActiveDb>
    /**
     * Build the store for `conn`, run pending migrations, make it the active
     * store, and report whether it already holds data (count for `cwd`). The old
     * store is torn down. On failure the active store is left untouched.
     */
    readonly switchTo: (
      name: string,
      conn: DatabaseConn,
      cwd: string,
    ) => Effect.Effect<SwitchResult, StoreSwitchError>
    /**
     * List a (possibly non-active) database's conversations for `cwd` via a
     * transient store, then tear it down — the per-connection sessions tabs.
     */
    readonly listSessions: (
      conn: DatabaseConn,
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<ConvSummary>, StoreSwitchError>
  }
>() {}
