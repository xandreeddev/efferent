import { Duration, Effect, Exit, Match, Option, Ref, Scope, Stream } from "effect"
import type { AiError } from "effect/ai"
import { HttpClient, HttpClientError } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import type { ModelSpend, ModelSpendExceeded, ModelSpendUnavailable } from "@xandreed/core/kernel"
import { CallReach } from "./call-reach.port.js"
import { DEFAULT_TIMEOUTS } from "./model-spend.entity.js"
import type { Charge, Reach, Reported, SpendOptions, Timeouts } from "./model-spend.entity.js"
import { heldBy, isRefusalStatus, ledgerUnavailable, neverConnected, settlementOf, spendRefused } from "./model-spend.entity.functions.js"

/** What charges a provider's calls: the ledger in its context, the host's spend options, and names for its failures. */
export interface Charging {
  readonly spend: ModelSpend["Service"]
  readonly options: SpendOptions
  readonly model: string
  /** The `AiError` module its failures name: the provider's. */
  readonly module: string
}

/** One call's hold, taken: where the provider reports what the call used, and the cell its client marks the request's reach in. */
export interface Held {
  readonly report: (reported: Reported) => Effect.Effect<void>
  readonly reach: Ref.Ref<Reach>
}

const refusedBy = (charging: Charging, method: string) => (error: ModelSpendExceeded | ModelSpendUnavailable): AiError.AiError =>
  Match.valueTags(error, {
    ModelSpendExceeded: (refusal) => spendRefused(refusal, charging.module, method),
    ModelSpendUnavailable: (unavailable) => ledgerUnavailable(unavailable, charging.module, method),
  })

/**
 * Take one call's hold in the scope it runs in, before anything is sent, and close it when that scope closes,
 * whatever ended it (an answer, a failure, an interruption): settled at what the provider reported, else at the
 * amount held once the request left, else released (`settlementOf`). The reservation is the acquire of an
 * `acquireRelease`, so it runs uninterruptibly with the finalizer that closes it: a hold the ledger took is always
 * closed. A refused reservation sends nothing and fails the call with the ledger's refusal, non-retryable
 * (`spendRefused`); a ledger that cannot be reached fails it too (closed, not sent). A close the ledger fails is
 * logged: a finalizer cannot fail.
 */
export const holdIn = Effect.fnUntraced(function* (charging: Charging, method: string, charge: Charge): Effect.fn.Return<Held, AiError.AiError, Scope.Scope> {
  const reach = yield* Ref.make<Reach>("Unsent")
  const reported = yield* Ref.make(Option.none<Reported>())
  yield* Effect.acquireRelease(
    charging.spend.reserve({ amount: heldBy(charge), caps: charging.options.caps ?? {} }).pipe(Effect.mapError(refusedBy(charging, method))),
    (hold) => Effect.all([Ref.get(reported), Ref.get(reach)], { concurrency: 1 }).pipe(
      Effect.flatMap(([usage, at]) => Option.match(settlementOf(charge, usage, at), {
        onSome: (cost) => charging.spend.settle(hold, cost),
        onNone: () => charging.spend.release(hold),
      })),
      Effect.ignore({ log: "Warn", message: "a model call's spend hold could not be closed in the ledger" }),
    ),
  )
  return { report: (usage: Reported) => Ref.set(reported, Option.some(usage)), reach }
})

/**
 * A call's stream, charged: its hold taken before `open` runs and closed when the stream ends, fails or is
 * interrupted (`holdIn`, in the stream's own scope). `open` sends the call: it reports what the provider said the
 * call used through the function it is given, and its client marks how far the request got (`reaching`).
 */
export const chargedStream = <A, E, R>(
  charging: Charging,
  method: string,
  charge: Charge,
  open: (report: Held["report"]) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E | AiError.AiError, Exclude<R, CallReach>> =>
  Stream.unwrap(Effect.map(holdIn(charging, method, charge), (held) => open(held.report).pipe(Stream.provideService(CallReach, held.reach))))

/**
 * A call that returns its answer whole, charged: its hold taken before `send` runs and closed when it ends, whatever
 * ended it.
 */
export const chargedEffect = <A, E, R>(
  charging: Charging,
  method: string,
  charge: Charge,
  send: (report: Held["report"]) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AiError.AiError, Exclude<R, CallReach>> =>
  Effect.scoped(Effect.flatMap(holdIn(charging, method, charge), (held) => send(held.report).pipe(Effect.provideService(CallReach, held.reach))))

/**
 * A call that sends its request in an effect and reads its answer from the stream that effect gives (Effect AI's
 * Anthropic client), charged: its hold taken before `send`, in a scope of its own, which closes when the stream
 * ends, fails or is interrupted, when `send` fails, and, as a guard, when the scope this runs in closes (a provider's
 * stream runs it inside one, which ends with the answer), whichever comes first.
 */
export const chargedSend = <S, A, E1, E2, R1>(
  charging: Charging,
  method: string,
  charge: Charge,
  send: (report: Held["report"]) => Effect.Effect<readonly [S, Stream.Stream<A, E2>], E1, R1>,
): Effect.Effect<readonly [S, Stream.Stream<A, E2>], E1 | AiError.AiError, Exclude<R1, CallReach>> =>
  Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const own = yield* Scope.make()
    const outer = yield* Effect.serviceOption(Scope.Scope)
    yield* Option.match(outer, { onNone: () => Effect.void, onSome: (scope) => Scope.addFinalizerExit(scope, (exit) => Scope.close(own, exit)) })
    const held = yield* holdIn(charging, method, charge).pipe(Scope.provide(own), Effect.onError((cause) => Scope.close(own, Exit.failCause(cause))))
    const [sent, stream] = yield* restore(send(held.report).pipe(Effect.provideService(CallReach, held.reach))).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(own, exit) : Effect.void)),
    )
    return [sent, stream.pipe(Stream.onExit((exit) => Scope.close(own, exit)))] as const
  }))

const timedOut = (request: HttpClientRequest.HttpClientRequest, wait: Duration.Duration) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: `no response came within ${Duration.format(wait)}` }) })

/**
 * A provider's HTTP client that marks, for the call being charged (`CallReach`), how far each request got: `Sent` as
 * it is handed to the transport, `Refused` when the provider answers with a refusal status (`isRefusalStatus`), and
 * `Unsent` again when the connection never opened (`neverConnected`). It gives up on a response whose headers do not
 * come within `response`, as a transport failure (the request left: the call settles at its hold).
 */
export const reaching = (timeouts: Timeouts) => (client: HttpClient.HttpClient): HttpClient.HttpClient => {
  const wait = Duration.fromInputUnsafe(timeouts.response ?? DEFAULT_TIMEOUTS.response)
  const mark = (reach: Reach) => Effect.flatMap(Effect.serviceOption(CallReach), Option.match({ onNone: () => Effect.void, onSome: (cell) => Ref.set(cell, reach) }))
  return client.pipe(HttpClient.transform((effect, request) => mark("Sent").pipe(
    Effect.andThen(effect),
    Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(timedOut(request, wait)) }),
    Effect.tap((response) => (isRefusalStatus(response.status) ? mark("Refused") : Effect.void)),
    Effect.tapError((error) => (error.reason._tag === "TransportError" && neverConnected(error.reason.cause) ? mark("Unsent") : Effect.void)),
  )))
}
