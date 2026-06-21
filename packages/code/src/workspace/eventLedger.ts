import { Effect, PubSub, Ref, Stream } from "effect"
import type { AgentEvent, SeqEvent } from "@xandreed/sdk-core"

/**
 * A per-session **event ledger** — the multi-client fan-out + reconnect/replay
 * core of the daemon split. It replaces the single `makeEventHooks` `Queue`
 * (one consumer) with:
 *
 *  - a monotonic **`seq`** stamped on every event (1, 2, 3, …),
 *  - a bounded **ring** of recent `SeqEvent`s (a short-gap replay cache),
 *  - a **`PubSub`** so any number of clients tail the same producer live.
 *
 * `stream(since?)` is the attach primitive: it **replays** the retained events
 * with `seq > since`, then **tails** the live PubSub — with the snapshot taken
 * *after* subscribing and the live tail filtered by the last replayed seq, so
 * each event is delivered exactly once, in order, with no gap at the seam (the
 * classic snapshot-then-subscribe race). When a client's `since` predates the
 * ring (events were evicted), {@link EventLedger.hasGap} is true → the transport
 * answers `resync` and the client re-fetches `/state` (a DB rebuild). Across a
 * daemon restart the ring is empty, so any prior `since` resyncs — no event is
 * ever silently lost.
 *
 * Pure live-layer state (no IO, no persistence) — the durable record stays the
 * conversation/context stores; this is the cache the in-process Workspace
 * publishes to and the HTTP/SSE transport tails.
 */
export interface EventLedger {
  /** Stamp the next `seq`, append to the ring (evicting the oldest past the
   *  bound), publish to all subscribers, and return the sequenced event. */
  readonly publish: (event: AgentEvent) => Effect.Effect<SeqEvent>
  /** The highest seq published so far (0 before anything). */
  readonly latestSeq: Effect.Effect<number>
  /** True when `since` is older than the ring can replay — the client missed
   *  evicted events and must resync from `/state`. */
  readonly hasGap: (since: number) => Effect.Effect<boolean>
  /** Retained events with `seq > since` (the whole ring when `since` omitted). */
  readonly replay: (since?: number) => Effect.Effect<ReadonlyArray<SeqEvent>>
  /** Replay the retained tail (`seq > since`), then stream live — exactly once,
   *  in order, no seam gap. The Workspace `subscribe` / SSE handler use this. */
  readonly stream: (since?: number) => Stream.Stream<SeqEvent>
}

interface LedgerState {
  readonly seq: number
  readonly ring: ReadonlyArray<SeqEvent>
}

/** Default ring depth — bounded like the bus's `MAX_BOARD`/`MAX_DONE`, but
 *  deeper since events outnumber board notes (a long turn emits hundreds). */
export const DEFAULT_LEDGER_RING = 1024

export const makeEventLedger = (
  opts: { readonly ringSize?: number } = {},
): Effect.Effect<EventLedger> =>
  Effect.gen(function* () {
    const ringSize = opts.ringSize ?? DEFAULT_LEDGER_RING
    const state = yield* Ref.make<LedgerState>({ seq: 0, ring: [] })
    const hub = yield* PubSub.unbounded<SeqEvent>()

    const publish: EventLedger["publish"] = (event) =>
      Effect.gen(function* () {
        const seqEvent = yield* Ref.modify(state, (s) => {
          const seq = s.seq + 1
          const se: SeqEvent = { seq, event }
          const ring = [...s.ring, se]
          while (ring.length > ringSize) ring.shift()
          return [se, { seq, ring }]
        })
        // Ring updated BEFORE publishing, so a subscriber that already holds the
        // snapshot can't see a live event whose seq isn't yet in any snapshot.
        yield* PubSub.publish(hub, seqEvent)
        return seqEvent
      })

    const firstRetained = (s: LedgerState): number =>
      s.ring.length > 0 ? s.ring[0]!.seq : s.seq + 1

    return {
      publish,
      latestSeq: Ref.get(state).pipe(Effect.map((s) => s.seq)),
      hasGap: (since) =>
        Ref.get(state).pipe(Effect.map((s) => firstRetained(s) > since + 1)),
      replay: (since) =>
        Ref.get(state).pipe(
          Effect.map((s) => s.ring.filter((e) => e.seq > (since ?? 0))),
        ),
      stream: (since) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            // Subscribe FIRST (capture the live tail), THEN snapshot the ring —
            // so an event published in between is in the live queue and can't be
            // missed. Dedup the seam by filtering the live tail past the last
            // replayed seq.
            const sub = yield* PubSub.subscribe(hub)
            const s = yield* Ref.get(state)
            const start = since ?? 0
            const replay = s.ring.filter((e) => e.seq > start)
            const fromSeq =
              replay.length > 0 ? replay[replay.length - 1]!.seq : start
            const live = Stream.fromQueue(sub).pipe(
              Stream.filter((e) => e.seq > fromSeq),
            )
            return Stream.concat(Stream.fromIterable(replay), live)
          }),
        ),
    }
  })
