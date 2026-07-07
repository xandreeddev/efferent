import { Effect, Fiber, Option, PubSub, Ref, Stream } from "effect"
import type { ConversationId } from "../domain/Message.js"

/**
 * The session chassis — the one runtime shape every agent driver needs, over
 * ONE persisted conversation and an append-only in-memory event ledger:
 *
 * - `send` runs a whole agent turn and SERIALIZES: a second send while a
 *   turn runs waits its turn (drivers coalesce user actions before here).
 * - `interrupt` stops the in-flight turn's fiber; the ledger survives.
 * - `subscribe(since)` replays the ledger from a cursor, then streams live,
 *   deduped by `seq` (the identity) — a client reconnecting mid-turn gets
 *   each event exactly once.
 *
 * Generic over the event vocabulary: a product composes `LoopEvent` with its
 * own `{ type: ... }` events and hands the chassis a `runTurn` that publishes
 * through the given sink. Turn failures and defects are CONTAINED: they
 * become an event (via `onError`), never a dead session.
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
  /** Interrupt the in-flight turn — the process-exit finalizer. */
  readonly shutdown: Effect.Effect<void>
}

export const makeSession = <E, RS = never>(args: {
  readonly conversationId: ConversationId
  /** Run one turn, publishing events through the sink. Errors/defects are
   *  contained by the chassis via `onError`. */
  readonly runTurn: (
    text: string,
    publish: (event: E) => Effect.Effect<void>,
  ) => Effect.Effect<void, unknown, RS>
  /** Map a turn failure into the product's error event. */
  readonly onError: (message: string) => E
}): Effect.Effect<Session<E>, never, RS> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<RS>()
    const log = yield* Ref.make<ReadonlyArray<SeqEvent<E>>>([])
    const hub = yield* PubSub.sliding<SeqEvent<E>>(512)
    const running = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())
    const gate = yield* Effect.makeSemaphore(1)

    const publish = (event: E): Effect.Effect<void> =>
      Ref.modify(log, (entries) => {
        const entry: SeqEvent<E> = { seq: entries.length, event }
        return [entry, [...entries, entry]] as const
      }).pipe(
        Effect.flatMap((entry) => PubSub.publish(hub, entry)),
        Effect.asVoid,
      )

    const runContained = (text: string): Effect.Effect<void> =>
      args.runTurn(text, publish).pipe(
        Effect.provide(context),
        Effect.catchAll((error) => publish(args.onError(String(error)))),
        Effect.catchAllDefect((defect) =>
          publish(args.onError(`turn crashed: ${String(defect)}`)),
        ),
      )

    const send = (text: string): Effect.Effect<void> =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(runContained(text))
          yield* Ref.set(running, Option.some(fiber))
          yield* Fiber.join(fiber).pipe(Effect.ignore)
          yield* Ref.set(running, Option.none())
        }),
      )

    const interrupt = Ref.get(running).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
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
        Stream.unwrapScoped(
          Effect.gen(function* () {
            // Subscribe FIRST, then snapshot — anything landing between the
            // snapshot and the live tail is deduped by seq (the identity).
            const sub = yield* PubSub.subscribe(hub)
            const entries = yield* Ref.get(log)
            const replay = Stream.fromIterable(entries.filter((e) => e.seq >= since))
            const seenThrough = entries.length
            const live = Stream.fromQueue(sub).pipe(
              Stream.filter((e) => e.seq >= Math.max(since, seenThrough)),
            )
            return Stream.concat(replay, live)
          }),
        ),
      shutdown: interrupt,
    } satisfies Session<E>
  })
