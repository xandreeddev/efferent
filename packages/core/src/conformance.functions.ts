import { Clock, Effect, Option, Schema } from "effect"
import type { Fiber } from "effect"
import { ConformanceFailure } from "./conformance.entity.js"
import type { ConformanceCheck } from "./conformance.entity.js"
import { ConversationId } from "./domain/message.entity.js"
import { zeroUsage } from "./domain/token-usage.entity.functions.js"
import type { TokenUsage } from "./domain/token-usage.entity.js"
import type { SessionHeader, SessionLogEvent } from "./session/session-log.entity.js"
import { randomUuid } from "./util/random-id.js"

/*
 * The helpers the conformance kits share. Private to core: the kits are
 * exported from the index, these are not.
 */

/** A `ConformanceFailure` by its tag and fields, whichever copy of core made it. */
const isConformanceFailure = (value: unknown): value is ConformanceFailure => Schema.is(Schema.Struct(ConformanceFailure.fields))(value)

export const fail = (check: string, message: string) => Effect.fail(new ConformanceFailure({ check, message }))
export const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check, message)

/** Two usages with every count equal. */
export const sameUsage = (a: TokenUsage, b: TokenUsage): boolean =>
  (Object.keys(zeroUsage) as ReadonlyArray<keyof TokenUsage>).every((key) => a[key] === b[key])

/** A 1x1 PNG, as base64: the image the kits attach. */
export const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

/** Each event as `kind@turn` (`kind` alone outside a turn), joined. */
export const kindsOf = (events: ReadonlyArray<SessionLogEvent>): string =>
  events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`).join()

/** Whether `fiber` completes within a few turns of the scheduler (an `idle` that should be settled). */
export const settles = (fiber: Fiber.Fiber<unknown, unknown>, tries = 50): Effect.Effect<boolean> =>
  fiber.pollUnsafe() !== undefined ? Effect.succeed(true)
    : tries <= 0 ? Effect.succeed(false)
    : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => settles(fiber, tries - 1))))

/** Read `value` until `holds`, letting other fibers run in between; the last value read. */
export const eventually = <A>(value: Effect.Effect<A>, holds: (a: A) => boolean, tries = 200): Effect.Effect<A> =>
  value.pipe(Effect.flatMap((now) => holds(now) || tries <= 0 ? Effect.succeed(now)
    : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(value, holds, tries - 1))))))

/** A fresh id per session, so a kit can run against a shared store. */
export const freshId = Effect.map(randomUuid, (id) => ConversationId.make(id))

export const headerOf = (id: ConversationId, owner: string, parent: Option.Option<{ readonly id: ConversationId; readonly through: number; readonly turnAtFork: number }> = Option.none()): SessionHeader => ({
  id, owner, origin: "user", createdAt: 1_767_225_600_000, meta: { title: "conformance", nested: { list: [1, "two", null] } }, parent,
})

/**
 * One check run under a fresh owner. A failure the body did not raise as a
 * `ConformanceFailure` (a port's own error, a defect-free typed failure) is
 * reported under `id` as unexpected, with its tag.
 */
export const check = (name: string, id: string, body: (owner: string) => Effect.Effect<void, unknown>): ConformanceCheck => ({
  name,
  run: freshId.pipe(
    Effect.flatMap((owner) => body(`owner-${owner}`)),
    Effect.catch((error: unknown) => isConformanceFailure(error) ? Effect.fail(error)
      : fail(id, `unexpected ${typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "error"}: ${JSON.stringify(error)}`)),
  ),
})

/** The caller's clock stopped at `at`: wall time only, sleeping still goes through the clock it stands in for. */
const stoppedAt = (at: number, clock: Clock.Clock): Clock.Clock => ({
  currentTimeMillisUnsafe: () => at,
  currentTimeMillis: Effect.succeed(at),
  currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: Effect.sync(() => clock.monotonicTimeNanosUnsafe()),
  sleep: (duration) => clock.sleep(duration),
})

/** Run `effect` with the wall clock stopped at `at`. */
export const atTime = (at: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Clock.clockWith((clock) => Effect.provideService(effect, Clock.Clock, stoppedAt(at, clock)))
