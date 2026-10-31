import { Context, Effect, Effectable, Option, Schema, Stream } from "effect"
import type { SchemaAST } from "effect"
import { Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import {
  AfterToolDecision, BeforeToolDecision, CurrentAgentRun, CurrentAgentStep,
  ToolCallId, ToolInterceptAfterInput, ToolInterceptBeforeInput,
} from "@xandreed/core"
import type { ToolHandlers, ToolInterceptor, TurnError } from "@xandreed/core"
import { CurrentToolResultReceipt, toolInterceptError, toolResultReceiptGuardOf, withToolResultReceiptGuard } from "@xandreed/core/internal"
import type { ToolResultReceiptContext, ToolResultReceiptOwner } from "@xandreed/core/internal"
type Json = typeof Schema.Json.Type

/** The only authority accepted by the registry wrapper is a private handle closure. */
export interface ToolInterceptCapture {
  readonly input: Json
  readonly owner: Option.Option<ToolResultReceiptOwner>
}

const immutable = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(immutable)
  return Object.freeze(value)
}

/** Foreign callbacks/codecs keep their cause; turn failures are never tool results. */
export const toolInterceptBoundary = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TurnError, R> =>
  withToolResultReceiptGuard(effect).pipe(
    Effect.mapError(toolInterceptError),
    Effect.catchDefect((defect) => Effect.fail(toolInterceptError(defect))),
  )

/** Normalize a closed DTO before JSON copying so inherited serialization cannot change it. */
export const toolInterceptSnapshot = Effect.fnUntraced(function* <A, I>(schema: Schema.Codec<A, I>, input: unknown): Effect.fn.Return<A, TurnError> {
  return yield* toolInterceptBoundary(Effect.gen(function* () {
    const normalized = yield* Schema.decodeUnknownEffect(Schema.toType(schema), { onExcessProperty: "error" })(input)
    const codec = Schema.fromJsonString(schema)
    const json = yield* Schema.encodeEffect(codec)(normalized)
    return immutable(yield* Schema.decodeUnknownEffect(codec, { onExcessProperty: "error" })(json))
  }))
})

/** A separate mutable JSON copy for authored decoders, including scalar/null inputs. */
export const toolInterceptMutableJson = Effect.fnUntraced(function* (input: unknown) {
  const codec = Schema.fromJsonString(Schema.Json)
  return yield* toolInterceptBoundary(Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
    Effect.flatMap(Schema.encodeEffect(codec)), Effect.flatMap(Schema.decodeUnknownEffect(codec)),
  ))
})

export const beforeToolIntercept = Effect.fnUntraced(function* (service: ToolInterceptor["Service"], input: ToolInterceptBeforeInput) {
  const evidence = yield* toolInterceptSnapshot(ToolInterceptBeforeInput, input)
  const decision = yield* toolInterceptBoundary(Effect.suspend(() => service.before(evidence)).pipe(Effect.interruptible))
  return yield* toolInterceptSnapshot(BeforeToolDecision, decision)
})

export const afterToolIntercept = Effect.fnUntraced(function* (service: ToolInterceptor["Service"], input: ToolInterceptAfterInput) {
  const evidence = yield* toolInterceptSnapshot(ToolInterceptAfterInput, input)
  const decision = yield* toolInterceptBoundary(Effect.suspend(() => service.after(evidence)).pipe(Effect.interruptible))
  return yield* toolInterceptSnapshot(AfterToolDecision, decision)
})

/** Capture before parameter decoding, without changing a tool or exposing an ambient owner. */
export const interceptedToolkit = (
  base: Toolkit.Toolkit<Record<string, Tool.Any>>,
  services: Context.Context<never>,
  handlers: (name: string, capture: ToolInterceptCapture) => Effect.Effect<Context.Context<ToolHandlers>>,
): Toolkit.Toolkit<Record<string, Tool.Any>> => Object.assign(class {}, base, Effectable.Prototype<Toolkit.Toolkit<Record<string, Tool.Any>>>({
  label: "toolkit.intercepted",
  evaluate() {
    return Effect.map(base, (original) => ({
      tools: original.tools,
      handle: Effect.fnUntraced(function* (name: string, input: unknown, id?: string, options?: SchemaAST.ParseOptions) {
        if (!Object.hasOwn(original.tools, name)) return yield* original.handle(name, input, id, options)
        const captured = yield* toolInterceptSnapshot(Schema.Json, input).pipe(Effect.orDie)
        // The decoder may mutate its input. It gets its own mutable copy, not
        // the caller's object or the frozen callback/audit evidence.
        const decoderInput = yield* toolInterceptMutableJson(captured).pipe(Effect.orDie)
        const current = yield* CurrentToolResultReceipt
        const owner = Option.isSome(current) && current.value._tag === "Offer" && id !== undefined
          ? yield* current.value.offer.enter({ tool: name, toolCallId: ToolCallId.make(id), run: yield* CurrentAgentRun, step: Option.getOrElse(yield* CurrentAgentStep, () => 0) })
          : Option.none<ToolResultReceiptOwner>()
        const guard = Option.map(current, (value): ToolResultReceiptContext => ({ _tag: "Guard", guard: toolResultReceiptGuardOf(value) }))
        const privateHandlers = yield* handlers(name, { input: captured, owner })
        const actual = yield* base.pipe(Effect.provide(privateHandlers))
        const output = yield* actual.handle(name, decoderInput, id, options).pipe(
          Effect.provide(services), Effect.provideService(CurrentToolResultReceipt, guard),
        )
        return output.pipe(Stream.provideContext(services), Stream.provideService(CurrentToolResultReceipt, guard))
      }),
    } satisfies Toolkit.WithHandler<Record<string, Tool.Any>>))
  },
}))
