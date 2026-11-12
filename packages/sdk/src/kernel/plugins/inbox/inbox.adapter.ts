import { Deferred, Effect, Exit, HashMap, Layer, Option, Ref, Result } from "effect"
import { Core } from "@xandreed/core/kernel"
import { Loop } from "../../contracts/loop/loop.port.js"
import type { SessionId } from "@xandreed/core/kernel"
import type { Reply } from "../../contracts/loop/loop.entity.js"
import type { LoopFailure } from "../../contracts/loop/loop.port.js"
import { enqueue as queue, finish, inboxQueued, openInbox, take } from "./inbox.entity.functions.js"
import type { Enqueued } from "./inbox.entity.functions.js"
import { InboxClosed } from "../../contracts/inbox/inbox.entity.js"
import type { InboxOptions, InboxState } from "./inbox.entity.js"
import type { InboxRefused, Ticket } from "../../contracts/inbox/inbox.entity.js"
import { Inbox } from "../../contracts/inbox/inbox.port.js"

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

/**
 * The inbox's state, and beside it, plumbing with no rule of its own: what
 * the messages not taken yet wait with, by ticket, and the signal of the
 * last announcement of each session with a queue, whether its message
 * waits, was taken or runs. The next message's announcement follows it.
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
   * The worker of one session: it takes the next message, waits for that
   * message's own announcement, runs its turn, gives its reply, and stops
   * when nothing waits. The take is one transition, so the message it waits
   * for is the message it runs, and its turn starts after its listeners
   * heard of it. Taking a message and putting its reply in the hands of
   * what follows (the wait for its announcement, then its turn) is one
   * uninterruptible step, so the close of the scope finds every reply
   * either still waiting, which the finalizer fails, or with a worker that
   * settles it.
   */
  const worker = (session: SessionId): Effect.Effect<void> => Effect.gen(function* () {
    while (true) {
      const ran = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // One transition: the first message waiting leaves the queue, or, when none waits, the session's queue goes, and
        // with it the signal of its last announcement, which this worker has waited for.
        const next = yield* Ref.modify(held, (now): readonly [Option.Option<{ readonly message: string; readonly waiting: Option.Option<Waiting> }>, Held] => {
          const taken = take(now.state, session)
          return Option.match(taken.next, {
            onNone: () => [Option.none(), { ...now, state: taken.state, announcing: HashMap.remove(now.announcing, session) }],
            onSome: (pending) => [
              Option.some({ message: pending.message, waiting: HashMap.get(now.waiting, pending.ticket) }),
              { ...now, state: taken.state, waiting: HashMap.remove(now.waiting, pending.ticket) },
            ],
          })
        })
        if (Option.isNone(next)) return false
        const { message, waiting } = next.value
        // Its own announcement first: failed or not, the turn runs; cut short by the scope's close, it starts no turn. A
        // failed turn fails its own reply, and the next message runs. Either cut short by the close fails the reply with
        // `InboxClosed`.
        const heard = Option.match(waiting, { onNone: () => Effect.void, onSome: (entry) => Deferred.await(entry.announced) })
        yield* restore(Effect.andThen(heard, loop.run({ session, message }))).pipe(
          Effect.onExit((exit) => Option.match(waiting, {
            onNone: () => Effect.void,
            onSome: (entry) => Deferred.done(entry.answer, Exit.hasInterrupts(exit) ? Exit.fail(closed()) : exit),
          })),
          Effect.exit,
        )
        return true
      }))
      if (!ran) return
    }
  })

  /**
   * Publish that a message was queued. Every listener the publisher waits
   * for hears of it, and none can fail the queueing: a failure is reported,
   * as core reports a background one.
   */
  const announceQueued = (session: SessionId, ticket: Ticket) => core.publish(inboxQueued(session, ticket), { listenerFailures: "report" })

  return Inbox.of({
    enqueue: Effect.fn("kernel.inbox.enqueue")(function* (session: SessionId, message: string) {
      const answer = yield* Deferred.make<Reply, LoopFailure | InboxClosed>()
      const announced = yield* Deferred.make<void>()
      // One uninterruptible step, which waits for nothing: the queueing, the announcement and the worker it planned are
      // started, and the caller has its ticket and reply whatever becomes of them.
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        // The ticket, the queueing and whether a worker starts: one transition, with the reply registered in the same step.
        // The announcement it follows is the session's last, whether that message waits, was taken or runs.
        const decided = yield* Ref.modify(held, (now): readonly [Result.Result<{ readonly queued: Enqueued; readonly after: Option.Option<Deferred.Deferred<void>> }, InboxRefused>, Held] =>
          Result.match(queue(now.state, session, message, capacity), {
            onFailure: (refused) => [Result.fail(refused), now],
            onSuccess: (queued) => [
              Result.succeed({ queued, after: HashMap.get(now.announcing, session) }),
              {
                state: queued.state,
                waiting: HashMap.set(now.waiting, queued.ticket, { answer, announced }),
                announcing: HashMap.set(now.announcing, session, announced),
              },
            ],
          }))
        const { queued, after } = yield* Effect.fromResult(decided)
        // Announced on a fiber of the plugin, after the session's announcement before it, so no caller holds it and none is
        // held by it. Its turn waits for it: failed or not, the turn runs; cut short by the close, it does not.
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
