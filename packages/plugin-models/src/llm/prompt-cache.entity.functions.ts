import { Option, Result, Schema } from "effect"
import { CachePosition, PromptCacheControl, PromptCacheError, PromptCacheSettings } from "./prompt-cache.entity.js"
import type { BreakpointInput, BreakpointPlan, PromptCacheTtl } from "./prompt-cache.entity.js"

const error = (reason: PromptCacheError["reason"], message: string) => new PromptCacheError({ reason, message })
const lifetime = (control: PromptCacheControl): PromptCacheTtl => control.ttl ?? "5m"

const callerControl = (control: unknown): Result.Result<Option.Option<PromptCacheControl>, PromptCacheError> => {
  if (control === null || control === undefined) return Result.succeed(Option.none())
  const invalid = () => Result.fail(error("Control", "A prompt cache control must be ephemeral with an optional five-minute or one-hour lifetime."))
  if (typeof control !== "object") return invalid()
  const prototype = Object.getPrototypeOf(control)
  if (prototype !== Object.prototype && prototype !== null) return invalid()
  // Inspect descriptors before schema access: inherited fields, accessors and serializers
  // can otherwise validate one lifetime while JSON sends another, or no control at all.
  if ("toJSON" in control || !Object.hasOwn(control, "type") || ("ttl" in control && !Object.hasOwn(control, "ttl")) || !Reflect.ownKeys(control).every((key) => {
    const field = Object.getOwnPropertyDescriptor(control, key)
    return (key === "type" || key === "ttl") && field !== undefined && field.enumerable && Object.hasOwn(field, "value")
  })) return invalid()
  // Validation must retain the original reference: it is also the origin token at the SDK edge.
  if (!Schema.is(PromptCacheControl)(control) || Result.isFailure(Schema.decodeUnknownResult(PromptCacheControl)(control, { onExcessProperty: "error" }))) return invalid()
  return Result.succeed(Option.some(control))
}

const orderedLifetimes = (indexes: ReadonlyArray<number>, ttlAt: (index: number) => PromptCacheTtl): boolean => {
  const lifetimes = indexes.toSorted((left, right) => left - right).map(ttlAt)
  const firstShort = lifetimes.indexOf("5m")
  return firstShort === -1 || lifetimes.lastIndexOf("1h") < firstShort
}

/**
 * Plan over actual cacheable wire positions, after SDK conversion. Caller controls are immutable;
 * Auto candidates compete by priority, then later wire position, within four effective slots.
 */
export const planBreakpoints = (input: BreakpointInput): Result.Result<BreakpointPlan, PromptCacheError> => Result.gen(function* () {
  const controls = yield* Result.all(input.positions.map((position) => CachePosition.match(position, {
    Unmarked: () => Result.succeed(Option.none<PromptCacheControl>()),
    Caller: (value) => callerControl(value.control),
    Auto: () => Result.succeed(Option.none<PromptCacheControl>()),
  })))
  const callerTopLevel = yield* callerControl(input.callerTopLevel)
  const callerIndexes = controls.flatMap((control, index) => Option.isSome(control) ? [index] : [])
  if (!input.capability) {
    if (callerIndexes.length > 0 || Option.isSome(callerTopLevel)) return yield* Result.fail(error("Capability", "This Messages endpoint does not support prompt cache controls."))
    return { selectedAuto: [], topLevel: Option.none() }
  }

  const topLevel = Option.orElse(callerTopLevel, () => PromptCacheSettings.match(input.policy, {
    Auto: () => Option.none<PromptCacheControl>(),
    TopLevel: (value) => Option.some<PromptCacheControl>({ type: "ephemeral", ttl: value.ttl }),
    Off: () => Option.none<PromptCacheControl>(),
  }))
  const finalIndex = input.positions.length - 1
  if (Option.isSome(topLevel) && finalIndex < 0) return yield* Result.fail(error("TopLevel", "A top-level prompt cache control needs a cacheable request block."))
  const finalCaller = controls[finalIndex] ?? Option.none()
  if (Option.isSome(topLevel) && Option.exists(finalCaller, (control) => lifetime(control) !== lifetime(topLevel.value))) return yield* Result.fail(error("TopLevel", "The top-level prompt cache control must match the final block's lifetime."))
  const occupied = Option.isSome(topLevel) && Option.isNone(finalCaller) ? [...callerIndexes, finalIndex] : callerIndexes
  if (occupied.length > 4) return yield* Result.fail(error("Capacity", "A Messages request supports at most four effective prompt cache breakpoints."))

  const autoTtl = PromptCacheSettings.match(input.policy, {
    Auto: (value) => value.ttl,
    TopLevel: (value) => value.ttl,
    Off: (): PromptCacheTtl => "5m",
  })
  const ttlAt = (index: number): PromptCacheTtl => {
    if (index === finalIndex && Option.isSome(topLevel)) return lifetime(topLevel.value)
    return Option.match(controls[index] ?? Option.none(), { onNone: () => autoTtl, onSome: lifetime })
  }
  if (!orderedLifetimes(occupied, ttlAt)) return yield* Result.fail(error("TtlOrder", "Place one-hour prompt cache controls before five-minute controls."))

  const selectedAuto = PromptCacheSettings.match(input.policy, {
    Auto: () => input.positions.flatMap((position, index) => CachePosition.match(position, {
      Unmarked: () => [],
      Caller: () => [],
      Auto: (value) => [{ index, priority: value.priority }],
    })).toSorted((left, right) => left.priority - right.priority || right.index - left.index).reduce<ReadonlyArray<number>>((selected, candidate) => {
      // The top-level control already occupies this position; an explicit Auto marker adds no prefix.
      if (candidate.index === finalIndex && Option.isSome(topLevel)) return selected
      const next = [...occupied, ...selected, candidate.index]
      return next.length <= 4 && orderedLifetimes(next, ttlAt) ? [...selected, candidate.index] : selected
    }, []),
    TopLevel: () => [],
    Off: () => [],
  })
  return { selectedAuto: selectedAuto.toSorted((left, right) => left - right), topLevel }
})
