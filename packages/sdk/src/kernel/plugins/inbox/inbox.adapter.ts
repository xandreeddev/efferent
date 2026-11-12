import { Array as Arr, Deferred, Effect, Exit, HashMap, Layer, Option, Ref, Result } from "effect"
import { Core, listenerFailed, Loop } from "@xandreed/core/kernel"
import type { LoopFailure, Reply, SessionId } from "@xandreed/core/kernel"
import { enqueue as queue, finish, inboxQueued, openInbox, take, waitingFor } from "./inbox.entity.functions.js"
import type { Enqueued } from "./inbox.entity.functions.js"
import { InboxClosed } from "./inbox.entity.js"
import type { InboxOptions, InboxRefused, InboxState, Pending, Ticket } from "./inbox.entity.js"
import { Inbox } from "./inbox.port.js"

const DEFAULT_CAPACITY = 64

type Answer = Deferred.Deferred<Reply, LoopFailure | InboxClosed>

/**
 * A queued message's reply, and the signal that its announcement is over:
 * done, failed or not, or interrupted with the plugin's scope.
 */
interface Waiting {
  readonly answer: Answer
  readonly announced: Deferred.Deferred<void>
}

/** The inbox's state, and beside it what the messages not taken yet wait with, by ticket: plumbing, no rule. */
interface Held {
  readonly state: InboxState
  readonly waiting: HashMap.HashMap<Ticket, Waiting>
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
  const held     = yield* Ref.make<Held>({ state: openInbox, waiting: HashMap.empty() })

  // The scope closes: what still waits is dropped, and its replies fail. A turn under way is the worker's to settle.
  yield* Effect.addFinalizer(() => Ref.modify(held, (now): readonly [ReadonlyArray<Waiting>, Held] => {
    const { state, dropped } = finish(now.state)
    return [dropped.flatMap(({ ticket }) => Option.toArray(HashMap.get(now.waiting, ticket))), { state, waiting: HashMap.empty() }]
  }).pipe(Effect.flatMap((all) => Effect.forEach(all, ({ answer }) => Deferred.fail(answer, closed()), { concurrency: 1, discard: true }))))

  /** The announcement of a message waiting for the session, the first or the last, if one waits: plumbing, read now. */
  const announcementOf = (now: Held, session: SessionId, pick: (all: ReadonlyArray<Pending>) => Option.Option<Pending>) =>
    Option.flatMap(pick(waitingFor(now.state, session)), (pending) => Option.map(HashMap.get(now.waiting, pending.ticket), (entry) => entry.announced))

  /**
   * The worker of one session: it waits for the announcement of the next
   * message, takes it, runs its turn, gives its reply, and stops when
   * nothing waits. A message leaves the queue only once announced, so its
   * turn starts after its listeners heard of it. Taking a message and
   * putting its reply in its turn's hands is one uninterruptible step, so
   * the close of the scope finds every reply either still waiting, which
   * the finalizer fails, or with a turn that settles it.
   */
  const worker = (session: SessionId): Effect.Effect<void> => Effect.gen(function* () {
    while (true) {
      // Only this worker takes the session's messages, so the first waiting now is the one it takes next. An announcement
      // cut short by the scope's close ends the worker here, the message still waiting, and starts no turn.
      const first = announcementOf(yield* Ref.get(held), session, Arr.head)
      if (Option.isSome(first)) yield* Deferred.await(first.value)
      const ran = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const next = yield* Ref.modify(held, (now): readonly [Option.Option<{ readonly message: string; readonly answer: Option.Option<Answer> }>, Held] => {
          const taken = take(now.state, session)
          return Option.match(taken.next, {
            onNone: () => [Option.none(), { ...now, state: taken.state }],
            onSome: (pending) => [
              Option.some({ message: pending.message, answer: Option.map(HashMap.get(now.waiting, pending.ticket), (entry) => entry.answer) }),
              { state: taken.state, waiting: HashMap.remove(now.waiting, pending.ticket) },
            ],
          })
        })
        if (Option.isNone(next)) return false
        const { message, answer } = next.value
        // A failed turn fails its own reply, and the next message runs. A turn cut short by the scope's close fails its reply with `InboxClosed`.
        yield* restore(loop.run({ session, message })).pipe(
          Effect.onExit((exit) => Option.match(answer, {
            onNone: () => Effect.void,
            onSome: (waiting) => Deferred.done(waiting, Exit.hasInterrupts(exit) ? Exit.fail(closed()) : exit),
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
            onSuccess: (queued) => [
              Result.succeed({ queued, after: announcementOf(now, session, Arr.last) }),
              { state: queued.state, waiting: HashMap.set(now.waiting, queued.ticket, { answer, announced }) },
            ],
          }))
        const { queued, after } = yield* Effect.fromResult(decided)
        // Announced on a fiber of the plugin, after the session's message before it while that one waits, so no caller holds
        // it and none is held by it. Its turn waits for it: failed or not, the turn runs; cut short by the close, it does not.
        const previous = Option.match(after, { onNone: () => Effect.void, onSome: (before) => Deferred.await(before) })
        yield* Effect.forkIn(Effect.andThen(previous, announceQueued(session, queued.ticket)).pipe(
          Effect.onExit((exit) => Exit.hasInterrupts(exit) ? Deferred.interrupt(announced) : Deferred.succeed(announced, undefined)),
        ), scope, { startImmediately: true })
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
