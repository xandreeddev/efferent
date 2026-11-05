import { describe, expect, test } from "bun:test"
import { Effect, Option, PubSub, RcMap, Result, Stream } from "effect"
import { SessionChannel } from "../ports/session-channel.port.js"
import { sessionChannelConformance } from "./session-channel.conformance.js"
import type { SessionChannelSubject } from "./session-channel.conformance.js"
import type { SessionChannelPayload } from "./session-channel.entity.js"
import type { SessionAddress } from "./sessions.entity.js"

/** What a careless channel gets wrong. */
interface Flaws {
  /** One hub for every session. */
  readonly shared?: boolean
  /** Keeps every payload and replays it to each new follower. */
  readonly replay?: boolean
  /** Buffers this many times the capacity it reports. */
  readonly slack?: number
  /** Reports every session it was ever asked to follow as held. */
  readonly leak?: boolean
}

const capacity = 4

/** A channel over one sliding hub per followed session, released with its last follower, with the given flaws. */
const subjectWith = (flaws: Flaws = {}): SessionChannelSubject => ({
  open: () => Effect.gen(function* () {
    const hubs = yield* RcMap.make({ lookup: (_: string) => Effect.acquireRelease(PubSub.sliding<SessionChannelPayload>(capacity * (flaws.slack ?? 1)), PubSub.shutdown) })
    const history = new Map<string, ReadonlyArray<SessionChannelPayload>>()
    const followed = new Set<string>()
    const keyOf = (address: SessionAddress) => flaws.shared === true ? "every session" : JSON.stringify([address.id, address.owner])
    const channel = SessionChannel.of({
      publish: (address, payload) => Effect.sync(() => {
        if (flaws.replay === true) history.set(keyOf(address), [...(history.get(keyOf(address)) ?? []), payload])
      }).pipe(
        Effect.andThen(RcMap.getOption(hubs, keyOf(address))),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (hub) => PubSub.publish(hub, payload).pipe(Effect.asVoid) })),
        Effect.scoped,
      ),
      subscribe: (address) => Stream.suspend(() => {
        followed.add(keyOf(address))
        return Stream.concat(Stream.fromIterable(history.get(keyOf(address)) ?? []), Stream.unwrap(RcMap.get(hubs, keyOf(address)).pipe(Effect.map(Stream.fromPubSub))))
      }),
    })
    const retained = flaws.leak === true ? Effect.sync(() => followed.size) : RcMap.keys(hubs).pipe(Effect.map((keys) => Array.from(keys).length))
    return { channel, capacity, retained }
  }),
})

/** A channel that delivers nothing and holds nothing. */
const silent: SessionChannelSubject = {
  open: () => Effect.succeed({ channel: SessionChannel.of({ publish: () => Effect.void, subscribe: () => Stream.never }), capacity, retained: Effect.succeed(0) }),
}

const failedChecks = (subject: SessionChannelSubject) => Effect.runPromise(Effect.forEach(sessionChannelConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => Result.isFailure(result) ? [result.failure.check] : [])), { concurrency: "unbounded" })).then((all) => all.flat())

describe("sessionChannelConformance", () => {
  sessionChannelConformance(subjectWith()).forEach((check) => test(check.name, () => Effect.runPromise(check.run)))

  test("the checks are the documented list", () => {
    expect(sessionChannelConformance(silent).map((check) => check.name)).toEqual([
      "every follower of a session receives its payloads in publish order",
      "a follower receives only its own session's payloads",
      "a payload published before a follower subscribed is never replayed to it",
      "a follower that does not pull keeps at most the channel's capacity, the newest",
      "a session's state is kept only while someone follows it",
    ])
  })

  test("a channel that delivers nothing fails every check", async () => {
    expect(await failedChecks(silent)).toEqual(["order", "isolation", "no-replay", "bounded", "release"])
  }, 30_000)

  test.each([
    ["one hub for every session", { shared: true }, "isolation"],
    ["a channel that replays what it was sent", { replay: true }, "no-replay"],
    ["a buffer larger than the capacity it reports", { slack: 4 }, "bounded"],
    ["state kept after the last follower left", { leak: true }, "release"],
  ] as const)("%s fails its check", async (_, flaws, failing) => {
    expect(await failedChecks(subjectWith(flaws))).toContain(failing)
  }, 30_000)
})
