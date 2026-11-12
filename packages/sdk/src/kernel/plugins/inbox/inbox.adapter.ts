import { Deferred, Effect, Exit, HashMap, Layer, Option, Ref, Result } from "effect"
import { Core, listenerFailed, Loop } from "@xandreed/core/kernel"
import type { LoopFailure, Reply, SessionId } from "@xandreed/core/kernel"
import { enqueue as queue, finish, inboxQueued, openInbox, take } from "./inbox.entity.functions.js"
import type { Enqueued } from "./inbox.entity.functions.js"
import { InboxClosed } from "./inbox.entity.js"
import type { InboxOptions, InboxRefused, InboxState, Ticket } from "./inbox.entity.js"
import { Inbox } from "./inbox.port.js"

const DEFAULT_CAPACITY = 64

/** A queued message's reply, and the signal that its announcement is done, whatever became of it. */
interface Waiting {
  readonly answer: Deferred.Deferred<Reply, LoopFailure | InboxClosed>
  readonly announced: Deferred.Deferred<void>
}

/**
 * The inbox's state, and beside it plumbing, no rule: what the messages not
 * taken yet wait with, by ticket, and the announcement of the last message
 * queued for each session whose worker runs, which the next one's follows.
 */
interface Held {
  readonly state: InboxState
  readonly waiting: HashMap.HashMap<Ticket, Waiting>
  readonly announcing: HashMap.HashMap<SessionId, Deferred.Deferred<void>>
}

const closed = () => new InboxClosed({ message: "the inbox closed before this message's turn ended" })

/**
 * The inbox plugin: a queue per session in the process, answered in
 * order, one turn at a time. Its state is one `Ref`, moved by the pure
 * transitions of `inbox.entity.functions.ts`; one worker per session,
 * forked in the plugin's scope, runs the session's turns through `Loop`
 * and stops when nothing waits. When the scope closes, every reply not
 * given yet fails with `InboxClosed`.
 */
const makeInbox = (options: InboxOptions) => Layer.effect(Inbox, Effect.gen(function* () {
  const core     = yield* Core
  const loop     = yield* Loop
  const scope    = yield* Effect.scope
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  const held     = yield* Ref.make<Held>({ state: openInbox, waiting: HashMap.empty(), announcing: HashMap.empty() })

  // The scope closes: what still waits is dropped, and its replies fail. A turn under way is the worker's to settle.
  yield* Effect.addFinalizer(() => Ref.modify(held, (now): readonly [ReadonlyArray<Waiting>, Held] => {
    const { state, dropped } = finish(now.state)
    return [dropped.flatMap(({ ticket }) => Option.toArray(HashMap.get(now.waiting, ticket))), { state, waiting: HashMap.empty(), announcing: HashMap.empty() }]
  }).pipe(Effect.flatMap((all) => Effect.forEach(all, ({ answer }) => Deferred.fail(answer, closed()), { concurrency: 1, discard: true }))))

  /**
   * The worker of one session: it takes the next message, waits for its
   * announcement, runs its turn, gives its reply, and stops when nothing
   * waits. Taking a message and putting its reply in the hands of what
   * runs next is one uninterruptible step, so the close of the scope finds
   * every reply either still waiting, which the finalizer fails, or with a
   * worker that settles it.
   */
  const worker = (session: SessionId): Effect.Effect<void> => Effect.gen(function* () {
    while (true) {
      const ran = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const next = yield* Ref.modify(held, (now): readonly [Option.Option<{ readonly message: string; readonly waiting: Option.Option<Waiting> }>, Held] => {
          const taken = take(now.state, session)
          return Option.match(taken.next, {
            // The worker stops: every message it took was announced, so the session's last announcement is done.
            onNone: () => [Option.none(), { ...now, state: taken.state, announcing: HashMap.remove(now.announcing, session) }],
            onSome: (pending) => [
              Option.some({ message: pending.message, waiting: HashMap.get(now.waiting, pending.ticket) }),
              { ...now, state: taken.state, waiting: HashMap.remove(now.waiting, pending.ticket) },
            ],
          })
        })
        if (Option.isNone(next)) return false
        const { message, waiting } = next.value
        // The message's announcement reaches its listeners before its turn starts. A failed turn fails its own reply, and
        // the next message runs; one cut short by the scope's close, before or after it started, fails it with `InboxClosed`.
        const announced = Option.match(waiting, { onNone: () => Effect.void, onSome: (entry) => Deferred.await(entry.announced) })
        yield* restore(Effect.andThen(announced, loop.run({ session, message }))).pipe(
          Effect.onExit((exit) => Option.match(waiting, {
            onNone: () => Effect.void,
            onSome: ({ answer }) => Deferred.done(answer, Exit.hasInterrupts(exit) ? Exit.fail(closed()) : exit),
          })),
          Effect.exit,
        )
        return true
      }))
      if (!ran) return
    }
  })

  /** Publish that a message was queued. A waiting listener that fails cannot fail the queueing: it is reported, as core reports a background one. */
  const announceQueued = (session: SessionId, ticket: Ticket) => {
    const event = inboxQueued(session, ticket)
    return core.publish(event).pipe(
      Effect.catchTag("ListenerFailed", (failure) => core.publish(listenerFailed(event, failure)).pipe(
        Effect.ignore({ log: "Warn", message: "the report of a failed listener could not be published" }),
      )),
    )
  }

  return Inbox.of({
    enqueue: Effect.fn("kernel.inbox.enqueue")(function* (session: SessionId, message: string) {
      const answer = yield* Deferred.make<Reply, LoopFailure | InboxClosed>()
      const announced = yield* Deferred.make<void>()
      // One uninterruptible step, which waits for nothing: the queueing, the announcement and the worker it planned are
      // started, and the caller has its ticket and reply whatever becomes of them.
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        // The ticket, the queueing and whether a worker starts: one transition, with the reply registered in the same step.
        const decided = yield* Ref.modify(held, (now): readonly [Result.Result<{ readonly queued: Enqueued; readonly after: Option.Option<Deferred.Deferred<void>> }, InboxRefused>, Held] =>
          Result.match(queue(now.state, session, message, capacity), {
            onFailure: (refused) => [Result.fail(refused), now],
            onSuccess: (queued) => [Result.succeed({ queued, after: HashMap.get(now.announcing, session) }), {
              state: queued.state,
              waiting: HashMap.set(now.waiting, queued.ticket, { answer, announced }),
              announcing: HashMap.set(now.announcing, session, announced),
            }],
          }))
        const { queued, after } = yield* Effect.fromResult(decided)
        // Announced on a fiber of the plugin, after the session's message before it, so no caller holds it and none is held
        // by it. Its turn waits for it; whatever becomes of it, failed or cut short, that turn runs.
        const previous = Option.match(after, { onNone: () => Effect.void, onSome: (before) => Deferred.await(before) })
        yield* Effect.forkIn(Effect.andThen(previous, announceQueued(session, queued.ticket)).pipe(Effect.ensuring(Deferred.succeed(announced, undefined))), scope, { startImmediately: true })
        if (queued.start) yield* Effect.forkIn(worker(session), scope)
        return { ticket: queued.ticket, reply: Deferred.await(answer) }
      }))
    }),
  })
}))

/**
 * The inbox with a queue of the given capacity per session.
 *
 * @public
 */
export const inboxOf = (options: InboxOptions): Layer.Layer<Inbox, never, Core | Loop> => makeInbox(options)

/**
 * The stock inbox plugin: messages queued per session and answered in
 * order, over `Loop`, with a queue of 64 per session. It needs `Core` and
 * `Loop`, and its type says so.
 *
 * @public
 */
export const inbox: Layer.Layer<Inbox, never, Core | Loop> = makeInbox({})
