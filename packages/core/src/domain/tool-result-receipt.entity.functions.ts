import { Effect, Match, Option, Ref, Schema } from "effect"
import type { EntryId } from "../memory/memory-log.entity.js"
import type { ToolResultReceipt, ToolResultReceiptContext, ToolResultReceiptGuard, ToolResultReceiptOwner } from "../ports/tool-result-receipt.port.js"
import { CurrentToolResultReceipt } from "../ports/tool-result-receipt.port.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { InvocationId } from "./run.entity.js"
import { ToolResultInterception } from "./tool-interceptor.entity.js"
import { toolInterceptError } from "./tool-interceptor.entity.functions.js"
import type { ToolResultReceiptPhase, ToolResultReceiptTarget } from "./tool-result-receipt.entity.js"

const immutable = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(immutable)
  return Object.freeze(value)
}
const metadataSchema = Schema.Struct({ metadata: Schema.OptionFromNullOr(ToolResultInterception) })

export const sameToolResultReceiptTarget = (left: ToolResultReceiptTarget, right: ToolResultReceiptTarget): boolean =>
  left.tool === right.tool && left.toolCallId === right.toolCallId && left.step === right.step && Option.match(left.run, {
    onNone: () => Option.isNone(right.run),
    onSome: (run) => Option.isSome(right.run) && right.run.value.id === run.id && right.run.value.turn === run.turn && right.run.value.ordinal === run.ordinal,
  })

/** Pure ownership rules; tokens remain in private closure state. */
export const enterToolResultReceipt = (phase: ToolResultReceiptPhase, handleToken: object): Option.Option<ToolResultReceiptPhase> =>
  phase._tag === "Fresh" ? Option.some({ _tag: "Entered", handleToken }) : Option.none()
export const claimToolResultReceipt = (phase: ToolResultReceiptPhase, handleToken: object, invocationId: InvocationId): Option.Option<ToolResultReceiptPhase> =>
  phase._tag === "Entered" && phase.handleToken === handleToken ? Option.some({ _tag: "Claimed", handleToken, invocationId }) : Option.none()
export const readyToolResultReceipt = (phase: ToolResultReceiptPhase, handleToken: object, metadata: Option.Option<ToolResultInterception>): Option.Option<ToolResultReceiptPhase> =>
  phase._tag === "Claimed" && phase.handleToken === handleToken && (Option.isNone(metadata) || metadata.value.invocationId === phase.invocationId)
    ? Option.some({ ...phase, _tag: "Ready", metadata }) : Option.none()
export const reserveToolResultReceipt = (phase: ToolResultReceiptPhase, recordToken: object): Option.Option<Extract<ToolResultReceiptPhase, { readonly _tag: "Recording" }>> => Match.value(phase).pipe(
  Match.tag("Fresh", () => Option.some({ _tag: "Recording" as const, recordToken, metadata: Option.none<ToolResultInterception>() })),
  Match.tag("Ready", ({ metadata }) => Option.some({ _tag: "Recording" as const, recordToken, metadata })),
  Match.orElse(() => Option.none()),
)
export const recordedToolResultReceipt = (phase: ToolResultReceiptPhase, recordToken: object, entry: EntryId): ToolResultReceiptPhase =>
  phase._tag === "Recording" && phase.recordToken === recordToken ? { _tag: "Recorded", entry } : phase

export const toolResultReceiptGuardOf = (context: ToolResultReceiptContext): ToolResultReceiptGuard => Match.valueTags(context, {
  Offer: ({ offer }) => offer.guard, Guard: ({ guard }) => guard, Record: ({ recording }) => recording.guard,
})
export const withToolResultReceiptGuard = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => CurrentToolResultReceipt.pipe(Effect.flatMap((context) => effect.pipe(
  Effect.provideService(CurrentToolResultReceipt, Option.map(context, (value): ToolResultReceiptContext => ({ _tag: "Guard", guard: toolResultReceiptGuardOf(value) }))),
)))

/** Allocate one local offer/recording capability; no global call-id registry or Scope requirement. */
export const makeToolResultReceipt = Effect.fnUntraced(function* (input: ToolResultReceiptTarget): Effect.fn.Return<ToolResultReceipt> {
  const target = immutable({ ...input, run: Option.map(input.run, (run) => ({ ...run })) })
  const phase = yield* Ref.make<ToolResultReceiptPhase>({ _tag: "Fresh" })
  const guard: ToolResultReceiptGuard = Object.freeze({ target, status: Ref.get(phase).pipe(Effect.map((current) => current._tag)) })
  const close = Ref.set(phase, { _tag: "Closed" })
  const advance = (operation: string, decide: (phase: ToolResultReceiptPhase) => Option.Option<ToolResultReceiptPhase>): Effect.Effect<void, TurnError> =>
    Ref.modify(phase, (current) => Option.match(decide(current), {
      onNone: (): readonly [boolean, ToolResultReceiptPhase] => [false, current],
      onSome: (next): readonly [boolean, ToolResultReceiptPhase] => [true, next],
    })).pipe(Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(toolInterceptError({ operation }))))
  const offer = Object.freeze({ guard, enter: Effect.fnUntraced(function* (actual: ToolResultReceiptTarget) {
    if (!sameToolResultReceiptTarget(target, actual)) return Option.none<ToolResultReceiptOwner>()
    const handleToken = Object.freeze({})
    const entered = yield* Ref.modify(phase, (current) => Option.match(enterToolResultReceipt(current, handleToken), {
      onNone: (): readonly [boolean, ToolResultReceiptPhase] => [false, current],
      onSome: (next): readonly [boolean, ToolResultReceiptPhase] => [true, next],
    }))
    if (!entered) return Option.none<ToolResultReceiptOwner>()
    const owner: ToolResultReceiptOwner = Object.freeze({ guard,
      claim: (invocationId: InvocationId) => advance("claim", (current) => claimToolResultReceipt(current, handleToken, invocationId)),
      ready: Effect.fnUntraced(function* (metadata: Option.Option<ToolResultInterception>) {
        const encoded = yield* Schema.encodeEffect(metadataSchema)({ metadata }).pipe(Effect.mapError(toolInterceptError))
        const json = yield* storedJson(encoded).pipe(Effect.mapError(toolInterceptError))
        const captured = immutable(yield* Schema.decodeUnknownEffect(metadataSchema)(json).pipe(Effect.mapError(toolInterceptError)))
        yield* advance("ready", (current) => readyToolResultReceipt(current, handleToken, captured.metadata))
      }),
    })
    return Option.some(owner)
  }) })
  const recording = Object.freeze({ guard, reserve: Effect.fnUntraced(function* (actual: ToolResultReceiptTarget) {
    if (!sameToolResultReceiptTarget(target, actual)) return yield* Effect.fail(toolInterceptError({ operation: "record target" }))
    const recordToken = Object.freeze({})
    const reservation = yield* Ref.modify(phase, (current) => Option.match(reserveToolResultReceipt(current, recordToken), {
      onNone: (): readonly [Option.Option<Extract<ToolResultReceiptPhase, { readonly _tag: "Recording" }>>, ToolResultReceiptPhase] => [Option.none(), current],
      onSome: (next): readonly [Option.Option<Extract<ToolResultReceiptPhase, { readonly _tag: "Recording" }>>, ToolResultReceiptPhase] => [Option.some(next), next],
    }))
    if (Option.isNone(reservation)) return yield* Effect.fail(toolInterceptError({ operation: "record reserve" }))
    return Object.freeze({ metadata: reservation.value.metadata, close,
      recorded: (entry: EntryId) => Ref.update(phase, (current) => recordedToolResultReceipt(current, recordToken, entry)),
    })
  }) })
  return Object.freeze({ guard, offer, recording, close })
})
