import { Deferred, Effect, Exit, Layer, Option, Ref, Result } from "effect"
import { Core, listenerFailed, Loop } from "@xandreed/core/kernel"
import type { LoopFailure, Reply, SessionId } from "@xandreed/core/kernel"
import { enqueue as queue, finish, inboxQueued, openInbox, take } from "./inbox.entity.functions.js"
import type { Enqueued } from "./inbox.entity.functions.js"
import { InboxClosed } from "./inbox.entity.js"
import type { InboxOptions, InboxRefused, InboxState, Ticket } from "./inbox.entity.js"
import { Inbox } from "./inbox.port.js"

const DEFAULT_CAPACITY = 64

type Answer = Deferred.Deferred<Reply, LoopFailure | InboxClosed>

/** The inbox's state, and beside it the replies of the messages still waiting, by session and ticket: plumbing, no rule. */
interface Held {
  readonly state: InboxState
  readonly replies: ReadonlyMap<string, Answer>
}

const keyOf = (session: SessionId, ticket: Ticket) => `${session}#${ticket}`
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
  const held     = yield* Ref.make<Held>({ state: openInbox, replies: new Map() })

  // The scope closes: what still waits is dropped, and its replies fail. A turn under way is the worker's to settle.
  yield* Effect.addFinalizer(() => Ref.modify(held, (now): readonly [ReadonlyArray<Answer>, Held] => {
    const { state, dropped } = finish(now.state)
    return [dropped.flatMap(({ session, ticket }) => Option.toArray(Option.fromNullishOr(now.replies.get(keyOf(session, ticket))))), { state, replies: new Map() }]
  }).pipe(Effect.flatMap((answers) => Effect.forEach(answers, (answer) => Deferred.fail(answer, closed()), { concurrency: 1, discard: true }))))

  /** The worker of one session: it takes the next message, runs its turn, gives its reply, and stops when nothing waits. */
  const worker = (session: SessionId): Effect.Effect<void> => Effect.gen(function* () {
    while (true) {
      const next = yield* Ref.modify(held, (now): readonly [Option.Option<{ readonly message: string; readonly answer: Option.Option<Answer> }>, Held] => {
        const taken = take(now.state, session)
        return Option.match(taken.next, {
          onNone: () => [Option.none(), { ...now, state: taken.state }],
          onSome: (pending) => [
            Option.some({ message: pending.message, answer: Option.fromNullishOr(now.replies.get(keyOf(session, pending.ticket))) }),
            { state: taken.state, replies: new Map(Array.from(now.replies).filter(([key]) => key !== keyOf(session, pending.ticket))) },
          ],
        })
      })
      if (Option.isNone(next)) return
      const { message, answer } = next.value
      // A failed turn fails its own reply, and the next message runs. A turn cut short by the scope's close fails its reply with `InboxClosed`.
      yield* loop.run({ session, message }).pipe(
        Effect.onExit((exit) => Option.match(answer, {
          onNone: () => Effect.void,
          onSome: (waiting) => Deferred.done(waiting, Exit.hasInterrupts(exit) ? Exit.fail(closed()) : exit),
        })),
        Effect.exit,
      )
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
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // The ticket, the queueing and whether a worker starts: one transition, with the reply registered in the same step.
        const decided = yield* Ref.modify(held, (now): readonly [Result.Result<Enqueued, InboxRefused>, Held] => Result.match(queue(now.state, session, message, capacity), {
          onFailure: (refused) => [Result.fail(refused), now],
          onSuccess: (queued) => [Result.succeed(queued), { state: queued.state, replies: new Map([...now.replies, [keyOf(session, queued.ticket), answer]]) }],
        }))
        const queued = yield* Effect.fromResult(decided)
        // Then announced, and then the worker it planned starts, whatever became of the announcement: no message is left with no worker.
        yield* restore(announceQueued(session, queued.ticket)).pipe(
          Effect.ensuring(queued.start ? Effect.asVoid(Effect.forkIn(worker(session), scope)) : Effect.void),
        )
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
