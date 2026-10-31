import { Schema } from "effect"
import type { Effect, Option } from "effect"
import { InboxQueuedData, InputDelivery, OpenTurn } from "@xandreed/core"

/*
 * The sessions plugin's own state, kept in the session head's `state` under
 * `sessions`: the turns begun, the open turn, the title and the inbox's
 * waiting items. It is a cache of the log (every change is committed with
 * the events that justify it), never read by a backend.
 */

/** One inbox item that is not done yet: waiting, or taken by an open turn. */
export const InboxSlot = Schema.Struct({
  /** The item's id, as `inbox.queued` stored it. */
  id: InboxQueuedData.fields.id,
  /** Turns that took it and did not finish it. */
  attempts: Schema.Int,
  claimedBy: Schema.OptionFromNullOr(Schema.Int),
  /** Absent for a legacy notice; user input is never dropped after failed attempts. */
  delivery: Schema.optionalKey(InputDelivery),
})
export type InboxSlot = typeof InboxSlot.Type

/**
 * Where a process-owned turn's holder runs: its host, its pid, and when that process started (a pid is reused).
 *
 * @public
 */
export const HolderProcess = Schema.Struct({ host: Schema.String, pid: Schema.Int, startedAt: Schema.Number })
export type HolderProcess = typeof HolderProcess.Type

/** The open turn as kept: under a lease, when it ends (`expiresAt`); under process ownership, none, and where its holder runs (none when an older version, or a runtime without a process, wrote it). */
export const HeldTurn = Schema.Struct({ ...OpenTurn.fields, process: Schema.OptionFromOptionalKey(HolderProcess) })
export type HeldTurn = typeof HeldTurn.Type

export const SessionsState = Schema.Struct({
  v: Schema.Literal(1),
  /**
   * The stored format (core's `STORED_FORMAT`) of the release that last
   * wrote the session: every commit of this release writes it, raised to its
   * own when lower. Absent in a state an earlier release wrote, read as 1. A
   * session whose format is above this release's is refused for writes and
   * turns (`session.version`).
   */
  format: Schema.optionalKey(Schema.Int),
  /** The highest turn number begun (a fork starts from its parent's). */
  turns: Schema.Int,
  open: Schema.OptionFromNullOr(HeldTurn),
  title: Schema.OptionFromNullOr(Schema.String),
  inbox: Schema.Array(InboxSlot),
})
export type SessionsState = typeof SessionsState.Type

/**
 * How the turns an instance begins are owned. A turn keeps how it was
 * taken (a lease end, or none and the holder's process), and every instance
 * judges it by that, whatever its own ownership: a change of ownership
 * between restarts, or instances that differ in it, neither hold a turn
 * forever nor reap one that is still held.
 *
 * @public
 */
export const Ownership = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("lease"),
    /** How long an open turn is held without a write (storage time). */
    ttlMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)),
    /**
     * `none`: the lease is fixed at begin; `on-commit`: each write extends it;
     * `everyMs`: each write extends it, and so does a keep-alive every
     * `everyMs` while the turn is open (the first one interval after the
     * begin), so a silent step (a slow model call, a long tool) keeps it.
     * `everyMs` is at most half of `ttlMs`, so a renewal lands before the
     * lease runs out even when one is late. A renewal is queued in order
     * with the turn's writes: it cannot pass a `write` or `transact` still
     * running, so keep those shorter than the lease.
     */
    renew: Schema.Union([Schema.Literals(["none", "on-commit"]), Schema.Struct({ everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100)) })]),
  }).annotate({
    description: "A turn is held for ttlMs (storage time) after its begin and after each renewal. renew: \"none\" fixes the lease at begin, \"on-commit\" extends it with each write, { everyMs } also extends it with a keep-alive every everyMs while the turn is open (the first one interval after the begin). everyMs must be at most half of ttlMs (everyMs * 2 <= ttlMs), or the options fail with config.options.",
  }).check(Schema.makeFilter((lease) => typeof lease.renew !== "object" || lease.renew.everyMs * 2 <= lease.ttlMs
    ? undefined
    : `renew.everyMs (${lease.renew.everyMs}) must be at most half of ttlMs (${lease.ttlMs}), so a keep-alive lands before the lease runs out`)),
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
    /** Refresh known waiting input across processes at this interval, default 100 ms. */
    pollIntervalMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))),
    /** Turns that may take a legacy notice and fail before it is dropped; queued user input is retained. */
    attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  }),
  /** The turn's write-behind queue: items before a writer waits, items taken per commit. */
  writer: Schema.Struct({
    capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
    batch: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  }),
  /** Compare-and-swap attempts before a write gives up as contended. */
  retries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  turns: Schema.Struct({
    /**
     * How long a turn may run, from when its writer is handed over, unless
     * its begin gives its own (`timeLimitMs`): past it, the turn is closed
     * as interrupted with `turn.time-limit`. At most a week.
     */
    timeLimitMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 604_800_000 })),
  }),
})
export type SessionsConfig = typeof SessionsConfig.Type

/** By default a turn is leased for 60 s, renewed by every write and by a keep-alive every 20 s, and may run for 6 hours. */
export const sessionsDefaults: SessionsConfig = {
  ownership: { mode: "lease", ttlMs: 60_000, renew: { everyMs: 20_000 } },
  titleChars: 80,
  inbox: { maxPending: 20, attempts: 2, pollIntervalMs: 100 },
  writer: { capacity: 1_024, batch: 64 },
  retries: 8,
  turns: { timeLimitMs: 21_600_000 },
}
