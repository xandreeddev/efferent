import { Schema } from "effect"
import type { Effect, Option } from "effect"
import { OpenTurn } from "@xandreed/core"

/*
 * The sessions plugin's own state, kept in the session head's `state` under
 * `sessions`: the turns begun, the open turn, the title and the inbox's
 * waiting items. It is a cache of the log (every change is committed with
 * the events that justify it), never read by a backend.
 */

/** One inbox item that is not done yet: waiting, or taken by an open turn. */
export const InboxSlot = Schema.Struct({
  id: Schema.String,
  /** Turns that took it and did not finish it. */
  attempts: Schema.Int,
  claimedBy: Schema.OptionFromNullOr(Schema.Int),
})
export type InboxSlot = typeof InboxSlot.Type

/** Where a process-owned turn's holder runs: its host, its pid, and when that process started (a pid is reused). */
export const HolderProcess = Schema.Struct({ host: Schema.String, pid: Schema.Int, startedAt: Schema.Number })
export type HolderProcess = typeof HolderProcess.Type

/** The open turn as kept: under process ownership, also where its holder runs (none when an older version wrote it). */
export const HeldTurn = Schema.Struct({ ...OpenTurn.fields, process: Schema.OptionFromOptionalKey(HolderProcess) })
export type HeldTurn = typeof HeldTurn.Type

export const SessionsState = Schema.Struct({
  v: Schema.Literal(1),
  /** The highest turn number begun (a fork starts from its parent's). */
  turns: Schema.Int,
  open: Schema.OptionFromNullOr(HeldTurn),
  title: Schema.OptionFromNullOr(Schema.String),
  inbox: Schema.Array(InboxSlot),
})
export type SessionsState = typeof SessionsState.Type

/** How a session's turns are owned. */
export const Ownership = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("lease"),
    /** How long an open turn is held without a write (storage time). */
    ttlMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)),
    /** `none`: the lease is fixed at begin; `on-commit`: each write extends it; `everyMs`: a keep-alive also extends it. */
    renew: Schema.Union([Schema.Literals(["none", "on-commit"]), Schema.Struct({ everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100)) })]),
  }),
  /**
   * One process per host: a turn is held, without expiry, for as long as the
   * process that began it runs. A turn left open by a process of this host
   * that has stopped is interrupted; one held on another host cannot be
   * checked and stays held (several hosts over one log need a lease).
   */
  Schema.Struct({ mode: Schema.Literal("process") }),
])
export type Ownership = typeof Ownership.Type

/**
 * How process ownership tells whether a turn's holder still runs: this
 * process as its turns record it (none where the runtime has no process to
 * name: its turns are then reaped by others as before), and whether the
 * process with a pid runs on this host.
 */
export interface ProcessLiveness {
  readonly current: Effect.Effect<Option.Option<HolderProcess>>
  readonly alive: (pid: number) => Effect.Effect<boolean>
}

export const SessionsConfig = Schema.Struct({
  ownership: Ownership,
  /** The title is the first user message, cut to this many characters. */
  titleChars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  inbox: Schema.Struct({
    /** Items that may wait at once. */
    maxPending: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    /** Turns that may take an item and fail before it is dropped. */
    attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  }),
  /** The turn's write-behind queue: items before a writer waits, items taken per commit. */
  writer: Schema.Struct({
    capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
    batch: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  }),
  /** Compare-and-swap attempts before a write gives up as contended. */
  retries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
})
export type SessionsConfig = typeof SessionsConfig.Type

export const sessionsDefaults: SessionsConfig = {
  ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" },
  titleChars: 80,
  inbox: { maxPending: 20, attempts: 2 },
  writer: { capacity: 1_024, batch: 64 },
  retries: 8,
}
