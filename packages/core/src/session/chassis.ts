import { Effect, Fiber, Option, PubSub, Ref, Stream, Semaphore } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import { replayableContext } from "../loop/traceContent.js"

/**
 * The session chassis — the one runtime shape every agent driver needs, over
 * ONE persisted conversation and an append-only in-memory event ledger:
 *
 * - `send` runs a whole agent turn and SERIALIZES: a second send while a
 *   turn runs waits its turn (drivers coalesce user actions before here).
 * - `interrupt` stops the in-flight turn's fiber; the ledger survives.
 * - `subscribe(since)` replays the ledger from a cursor, then streams live,
 *   deduped by `seq` (the identity): a client reconnecting mid-turn gets no
 *   event twice. The live tail is a sliding buffer of 512 events: a
 *   subscriber that falls further behind loses the oldest it has not read,
 *   with nothing to say so but a gap in `seq` (subscribe again from the
 *   last `seq` it saw to read them from the ledger).
 *
 * Generic over the event vocabulary: a product composes `LoopEvent` with its
 * own `{ type: ... }` events and hands the chassis a `runTurn` that publishes
 * through the given sink. Turn failures and defects are CONTAINED: they
 * become an event (via `onError`), never a dead session.
 *
 * Deprecated: see `makeSession`.
 */

export interface SeqEvent<E> {
  readonly seq: number
  readonly event: E
}

export interface Session<E> {
  readonly conversationId: ConversationId
  /** Run one agent turn (serialized with any in-flight turn). */
  readonly send: (text: string) => Effect.Effect<void>
  /** Interrupt the in-flight turn, if any (idempotent). */
  readonly interrupt: Effect.Effect<void>
  /** The full ledger + the next cursor (subscribe from here for live-only). */
  readonly state: Effect.Effect<{
    readonly log: ReadonlyArray<SeqEvent<E>>
    readonly cursor: number
  }>
  /** Every event with `seq >= since`: the replay prefix, then live. */
  readonly subscribe: (since: number) => Stream.Stream<SeqEvent<E>>
  /**
   * The live-only lossy channel: events `isTransient` claimed (token
   * deltas). Never ledgered, never replayed, sliding — safe to drop because
   * every transient fact is restated by a ledgered finalizer. Empty forever
   * when no `isTransient` was given.
   */
  readonly transient: Stream.Stream<E>
  /** Interrupt the in-flight turn — the process-exit finalizer. */
  readonly shutdown: Effect.Effect<void>
}

/**
 * @deprecated Compose agents with `Agent.define` and run each turn with
 * `Agent.turn` (`@xandreed/sdk`) over `Sessions` (`@xandreed/plugin-sessions`):
 * turns are journaled, serialized by the session and replayed from its
 * stored events. This chassis keeps its ledger in memory only, and its live
 * tail drops events for a subscriber that falls behind; it will be removed
 * in a later release.
 */
export const makeSession = Effect.fnUntraced(function* <E, RS = never>(args: {
  readonly conversationId: ConversationId
  /** Run one turn, publishing events through the sink. Errors/defects are
   *  contained by the chassis via `onError`. */
  readonly runTurn: (
    text: string,
    publish: (event: E) => Effect.Effect<void>,
  ) => Effect.Effect<void, unknown, RS>
  /** Map a turn failure into the product's error event. */
  readonly onError: (message: string) => E
  /** The event an INTERRUPTED turn leaves on the ledger — without one the
   *  ledger simply stops mid-turn and every driver has to say so by hand. */
  readonly onInterrupt?: () => E
  /** Route matching events to the lossy `transient` channel INSTEAD of the
   *  ledger — a delta flood must never grow the replay log. */
  readonly isTransient?: (event: E) => boolean
}): Effect.fn.Return<Session<E>, never, RS> {
  // Each turn runs with these, traced where it runs: under the span of `send`'s caller.
  const context = replayableContext(yield* Effect.context<RS>())
  const log = yield* Ref.make<ReadonlyArray<SeqEvent<E>>>([])
  const hub = yield* PubSub.sliding<SeqEvent<E>>(512)
  const transientHub = yield* PubSub.sliding<E>(128)
  const running = yield* Ref.make(Option.none<Fiber.Fiber<void>>())
  const gate = yield* Semaphore.make(1)

  const publish = (event: E): Effect.Effect<void> =>
    args.isTransient?.(event) === true
      ? PubSub.publish(transientHub, event).pipe(Effect.asVoid)
      : Ref.modify(log, (entries) => {
          const entry: SeqEvent<E> = { seq: entries.length, event }
          return [entry, [...entries, entry]] as const
        }).pipe(
          Effect.flatMap((entry) => PubSub.publish(hub, entry)),
          Effect.asVoid,
        )

  const runContained = (text: string): Effect.Effect<void> =>
    args.runTurn(text, publish).pipe(
      Effect.provide(context),
      Effect.catch((error) => publish(args.onError(String(error)))),
      Effect.catchDefect((defect) =>
        publish(args.onError(`turn crashed: ${String(defect)}`)),
      ),
      // The turn leaves its own trace, however it is interrupted: `interrupt`, or its sender's interruption.
      Effect.onInterrupt(() => args.onInterrupt === undefined ? Effect.void : publish(args.onInterrupt())),
    )

  const send = (text: string): Effect.Effect<void> =>
    gate.withPermits(1)(
      // The slot holds the turn from its fork until it ends, however it ends.
      Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(restore(runContained(text)))
        yield* Ref.set(running, Option.some(fiber))
        // AWAIT, never join: joining an interrupted turn would interrupt
        // the sender too — an interrupted turn ends the send normally,
        // its trace already on the ledger. An interrupted sender
        // interrupts its turn.
        yield* restore(Fiber.await(fiber)).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          Effect.ensuring(Ref.set(running, Option.none())),
        )
      })),
    )

  // Taken from the slot, so two interrupts stop the turn once. Interrupting
  // a turn that already finished on its own is a no-op AND leaves no event:
  // the turn publishes its trace only when it is cut short.
  const interrupt = Ref.getAndSet(running, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)), Effect.asVoid),
      }),
    ),
  )

  return {
    conversationId: args.conversationId,
    send,
    interrupt,
    state: Ref.get(log).pipe(
      Effect.map((entries) => ({ log: entries, cursor: entries.length })),
    ),
    subscribe: (since) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe FIRST, then snapshot — anything landing between the
          // snapshot and the live tail is deduped by seq (the identity).
          const sub = yield* PubSub.subscribe(hub)
          const entries = yield* Ref.get(log)
          const replay = Stream.fromIterable(entries.filter((e) => e.seq >= since))
          const seenThrough = entries.length
          const live = Stream.fromSubscription(sub).pipe(
            Stream.filter((e) => e.seq >= Math.max(since, seenThrough)),
          )
          return Stream.concat(replay, live)
        }),
      ),
    transient: Stream.fromPubSub(transientHub),
    shutdown: interrupt,
  } satisfies Session<E>
})
