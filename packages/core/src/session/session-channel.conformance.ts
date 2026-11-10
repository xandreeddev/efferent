import { Duration, Effect, Exit, Fiber, Option, Pull, Ref, Scope, Stream } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail, freshId } from "../conformance.functions.js"
import type { SessionChannel } from "../ports/session-channel.port.js"
import type { SessionChannelError, SessionChannelPayload } from "./session-channel.entity.js"
import type { SessionAddress } from "./sessions.entity.js"

/**
 * One fresh channel per check: the channel, the most payloads it keeps for
 * a follower that does not pull (`capacity`), and how many sessions it
 * keeps state for in this process (`retained`: a hub, a subscription, a
 * buffer), which falls back to zero once nobody follows them.
 *
 * @public
 */
export interface SessionChannelSubject {
  readonly open: () => Effect.Effect<{
    readonly channel: SessionChannel["Service"]
    readonly capacity: number
    readonly retained: Effect.Effect<number>
  }, unknown, Scope.Scope>
}

type Channel = SessionChannel["Service"]

const PROBE = "conformance.probe"
const probe: SessionChannelPayload = { event: PROBE, data: {} }
const payload = (event: string, n = 0): SessionChannelPayload => ({ event: `conformance.${event}`, data: { n } })
const numberOf = (received: SessionChannelPayload): number => typeof received.data.n === "number" ? received.data.n : -1
const namesOf = (received: ReadonlyArray<SessionChannelPayload>): string => received.map((one) => `${one.event}:${numberOf(one)}`).join()

/** How long a follower waits for the next payload before a check gives up on it. */
const PULL_WAIT = Duration.seconds(2)

/** A subscription a check reads at its own pace: it pulls only when the check asks. */
interface Follower {
  /** The payloads that arrive, probes left out, until one satisfies `until`; none when the channel sent nothing for `PULL_WAIT`. */
  readonly until: (until: (received: SessionChannelPayload) => boolean) => Effect.Effect<Option.Option<ReadonlyArray<SessionChannelPayload>>, SessionChannelError>
  readonly close: Effect.Effect<void>
}

/** Publish probes until the forked first pull has one: the subscription is then in place. */
const awaitFirst = (channel: Channel, address: SessionAddress, first: Fiber.Fiber<unknown, unknown>, tries: number): Effect.Effect<boolean, SessionChannelError> =>
  first.pollUnsafe() !== undefined ? Effect.succeed(true)
    : tries <= 0 ? Effect.succeed(false)
    : channel.publish(address, probe).pipe(
      Effect.andThen(Effect.sleep(Duration.millis(5))),
      Effect.andThen(Effect.suspend(() => awaitFirst(channel, address, first, tries - 1))),
    )

/**
 * Follow `address` and return once the subscription is in place: probes are
 * published to it until the first one arrives (whatever arrived with it is
 * kept for the follower's first read).
 */
const follow = (id: string, channel: Channel, address: SessionAddress) => Effect.gen(function* () {
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const close = Scope.close(scope, Exit.void)
  const next = yield* Scope.provide(Stream.toPull(channel.subscribe(address)), scope)
  const pull: Effect.Effect<ReadonlyArray<SessionChannelPayload>, SessionChannelError> = next.pipe(
    Pull.catchDone(() => Effect.succeed<ReadonlyArray<SessionChannelPayload>>([])),
    Effect.timeoutOption(PULL_WAIT),
    Effect.map(Option.getOrElse((): ReadonlyArray<SessionChannelPayload> => [])),
  )
  const first = yield* Effect.forkChild(pull)
  if (!(yield* awaitFirst(channel, address, first, 200))) {
    yield* close
    return yield* fail(id, "a follower received nothing published after it subscribed")
  }
  const pending = yield* Ref.make<ReadonlyArray<SessionChannelPayload>>(yield* Fiber.join(first))
  const read = (until: (received: SessionChannelPayload) => boolean, seen: ReadonlyArray<SessionChannelPayload>, pulls: number): Effect.Effect<Option.Option<ReadonlyArray<SessionChannelPayload>>, SessionChannelError> =>
    Ref.getAndSet(pending, []).pipe(
      Effect.flatMap((held) => held.length > 0 ? Effect.succeed(held) : pull),
      Effect.flatMap((chunk) => {
        if (chunk.length === 0 || pulls <= 0) return Effect.succeed(Option.none())
        const shown = chunk.filter((received) => received.event !== PROBE)
        const at = shown.findIndex(until)
        return at >= 0
          ? Ref.set(pending, shown.slice(at + 1)).pipe(Effect.as(Option.some([...seen, ...shown.slice(0, at + 1)])))
          : read(until, [...seen, ...shown], pulls - 1)
      }),
    )
  const follower: Follower = { until: (until) => read(until, [], 10_000), close }
  return follower
})

/** What `follower` receives until the payload named `event`; a failure of the check when it never comes. */
const receive = (id: string, follower: Follower, event: string, what: string) => follower.until((received) => received.event === `conformance.${event}`).pipe(
  Effect.flatMap(Option.match({ onNone: () => fail(id, `a follower never received ${what}`), onSome: Effect.succeed })),
)

const marks = (received: ReadonlyArray<SessionChannelPayload>): ReadonlyArray<number> => received.filter((one) => one.event === "conformance.mark").map(numberOf)

/**
 * The `SessionChannel` contract: payloads reach every follower of their
 * session in publish order, never another session's follower (an address
 * is its id and its owner), never one that subscribed after them; a
 * follower that does not pull keeps at most the channel's capacity, the
 * newest; and a session's state is kept only while someone follows it.
 *
 * @public
 */
export const sessionChannelConformance = (subject: SessionChannelSubject): ReadonlyArray<ConformanceCheck> => [
  check("every follower of a session receives its payloads in publish order", "order", (owner) => Effect.scoped(Effect.gen(function* () {
    const { channel, capacity } = yield* subject.open()
    const address = { id: yield* freshId, owner }
    const first = yield* follow("order", channel, address)
    const second = yield* follow("order", channel, address)
    // Both read while they are sent, and no more are sent than a follower keeps, so none is lost to a slow reader.
    const reading = yield* Effect.forkChild(Effect.forEach([first, second], (follower) => receive("order", follower, "end", "the last payload"), { concurrency: 2 }))
    const sent = Array.from({ length: Math.min(5, Math.max(1, capacity - 1)) }, (_, index) => index + 1)
    yield* Effect.forEach([...sent.map((n) => payload("mark", n)), payload("end")], (one) => channel.publish(address, one).pipe(Effect.andThen(Effect.yieldNow)), { concurrency: 1, discard: true })
    const received = yield* Fiber.join(reading)
    yield* expect("order", received.every((one) => marks(one).join() === sent.join()), `followers received ${received.map(namesOf).join(" and ")}, not marks ${sent.join()} in order`)
  }))),
  check("a follower receives only its own session's payloads", "isolation", (owner) => Effect.scoped(Effect.gen(function* () {
    const { channel } = yield* subject.open()
    const address = { id: yield* freshId, owner }
    const follower = yield* follow("isolation", channel, address)
    yield* channel.publish({ id: yield* freshId, owner }, payload("theirs", 1))
    yield* channel.publish({ id: address.id, owner: `${owner}-other` }, payload("theirs", 2))
    yield* channel.publish(address, payload("mine"))
    const received = yield* receive("isolation", follower, "mine", "its own session's payload")
    yield* expect("isolation", received.every((one) => one.event !== "conformance.theirs"), `a follower received another session's payload (${namesOf(received)}): the same id under another owner, or another id`)
  }))),
  check("a payload published before a follower subscribed is never replayed to it", "no-replay", (owner) => Effect.scoped(Effect.gen(function* () {
    const { channel } = yield* subject.open()
    const address = { id: yield* freshId, owner }
    yield* channel.publish(address, payload("early"))
    const follower = yield* follow("no-replay", channel, address)
    yield* channel.publish(address, payload("late"))
    const received = yield* receive("no-replay", follower, "late", "a payload published after it subscribed")
    yield* expect("no-replay", received.every((one) => one.event !== "conformance.early"), "a follower received a payload published before it subscribed: the channel replays what it should not keep")
  }))),
  check("a follower that does not pull keeps at most the channel's capacity, the newest", "bounded", (owner) => Effect.scoped(Effect.gen(function* () {
    const { channel, capacity } = yield* subject.open()
    const address = { id: yield* freshId, owner }
    const follower = yield* follow("bounded", channel, address)
    const sent = capacity * 3
    yield* Effect.forEach(Array.from({ length: sent }, (_, index) => index + 1), (n) => channel.publish(address, payload("mark", n)), { concurrency: 1, discard: true })
    const received = marks(yield* follower.until((one) => numberOf(one) === sent).pipe(
      Effect.flatMap(Option.match({ onNone: () => fail("bounded", "a follower that fell behind never received the newest payload"), onSome: Effect.succeed })),
    ))
    const ordered = received.every((n, index) => index === 0 || n > (received[index - 1] ?? 0))
    yield* expect("bounded", received.length <= capacity && ordered && received.at(-1) === sent,
      `a follower that did not pull while ${sent} payloads were published then received ${received.length} (capacity ${capacity}), ending with ${received.at(-1) ?? "none"}`)
  }))),
  check("a session's state is kept only while someone follows it", "release", (owner) => Effect.scoped(Effect.gen(function* () {
    const { channel, retained } = yield* subject.open()
    const address = { id: yield* freshId, owner }
    yield* channel.publish(address, payload("unfollowed"))
    yield* expect("release", (yield* retained) === 0, "a payload published while nobody followed its session left state behind")
    const first = yield* follow("release", channel, address)
    const second = yield* follow("release", channel, address)
    yield* expect("release", (yield* retained) > 0, "a followed session reports no state: retained does not count what the channel holds")
    yield* first.close
    yield* channel.publish(address, payload("after"))
    yield* receive("release", second, "after", "a payload once another follower of its session had left")
    yield* second.close
    const left = yield* eventuallyZero(retained, 200)
    yield* expect("release", left === 0, `${left} session(s) still held once their last follower left`)
  }))),
]

/** `retained` read until it is zero, letting the channel's finalizers run in between; the last count read. */
const eventuallyZero = (retained: Effect.Effect<number>, tries: number): Effect.Effect<number> => retained.pipe(
  Effect.flatMap((count) => count === 0 || tries <= 0 ? Effect.succeed(count)
    : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(Effect.suspend(() => eventuallyZero(retained, tries - 1))))),
)
