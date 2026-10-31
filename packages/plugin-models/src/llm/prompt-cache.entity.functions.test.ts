import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Option, Result, Schema } from "effect"
import { BreakpointPlan, CachePosition, PromptCacheSettings } from "./prompt-cache.entity.js"
import type { BreakpointInput, PromptCacheControl, PromptCacheTtl } from "./prompt-cache.entity.js"
import { planBreakpoints } from "./prompt-cache.entity.functions.js"

const unmarked: CachePosition = { _tag: "Unmarked" }
const auto = (priority: number): CachePosition => ({ _tag: "Auto", priority })
const caller = (control: unknown): CachePosition => ({ _tag: "Caller", control })
const control = (ttl?: PromptCacheTtl): PromptCacheControl => ({ type: "ephemeral", ...(ttl === undefined ? {} : { ttl }) })
const request = (positions: ReadonlyArray<CachePosition>, overrides: Partial<BreakpointInput> = {}): BreakpointInput => ({ positions, policy: { _tag: "Auto", ttl: "5m" }, capability: true, ...overrides })
const plan = (positions: ReadonlyArray<CachePosition>, overrides: Partial<BreakpointInput> = {}) => planBreakpoints(request(positions, overrides))
const value = (result: ReturnType<typeof planBreakpoints>) => Result.getOrThrowWith(result, (error) => new Error(error.message))
const failure = (result: ReturnType<typeof planBreakpoints>) => Result.isFailure(result) ? { reason: result.failure.reason, message: result.failure.message } : { reason: "accepted", message: "accepted" }

describe("prepared Messages prompt-cache planning", () => {
  test("the public policy is a strict tagged choice with a supported lifetime", () => {
    const choices: ReadonlyArray<PromptCacheSettings> = [{ _tag: "Auto", ttl: "5m" }, { _tag: "Auto", ttl: "1h" }, { _tag: "TopLevel", ttl: "5m" }, { _tag: "TopLevel", ttl: "1h" }, { _tag: "Off" }]
    choices.forEach((choice) => expect(Schema.decodeUnknownOption(PromptCacheSettings)(choice, { onExcessProperty: "error" })).toEqual(Option.some(choice)))
    ;[{ _tag: "Auto" }, { _tag: "TopLevel", ttl: "10m" }, { _tag: "Off", ttl: "5m" }, { _tag: "Unknown" }].forEach((choice) => expect(Schema.decodeUnknownOption(PromptCacheSettings)(choice, { onExcessProperty: "error" })).toEqual(Option.none()))
    expect(Schema.is(CachePosition)(auto(-1))).toBe(false)
    expect(Schema.is(CachePosition)(auto(0.5))).toBe(false)
    expect(Schema.is(BreakpointPlan)({ selectedAuto: [2, 1], topLevel: Option.none() })).toBe(false)
    expect(Schema.is(BreakpointPlan)({ selectedAuto: [1, 1], topLevel: Option.none() })).toBe(false)
  })

  test("ordinary Auto chooses the latest stable messages and system, returning wire order", () => {
    expect(value(plan([auto(2), unmarked, auto(1), auto(0), unmarked]))).toEqual({ selectedAuto: [0, 2, 3], topLevel: Option.none() })
    expect(value(plan([]))).toEqual({ selectedAuto: [], topLevel: Option.none() })
    expect(value(plan([unmarked, unmarked]))).toEqual({ selectedAuto: [], topLevel: Option.none() })
  })

  test("priority beats wire position and equal-priority fanout prefers the later location", () => {
    const positions = [auto(0), auto(1), auto(0), auto(2), caller(control()), caller(control()), caller(control())]
    expect(value(plan(positions)).selectedAuto).toEqual([2])
    expect(value(plan([auto(0), auto(0), auto(0), auto(0), auto(0)] )).selectedAuto).toEqual([1, 2, 3, 4])
    expect(value(plan([auto(2), auto(1), caller(control()), caller(control()), auto(0)])).selectedAuto).toEqual([1, 4])
  })

  test("caller controls consume slots without replacement, including one object reused at several positions", () => {
    const shared = Object.freeze(control())
    expect(value(plan([caller(shared), caller(shared), caller(shared), caller(shared), auto(0)]))).toEqual({ selectedAuto: [], topLevel: Option.none() })
    expect(failure(plan([caller(shared), caller(shared), caller(shared), caller(shared), caller(shared)]))).toEqual({ reason: "Capacity", message: "A Messages request supports at most four effective prompt cache breakpoints." })
  })

  test("omitted TTL compares as five minutes, while input values and identities stay unchanged", () => {
    const top = Object.freeze(control())
    const final = Object.freeze(control("5m"))
    const positions = Object.freeze([Object.freeze(auto(0)), Object.freeze(caller(final))])
    const input = Object.freeze(request(positions, { callerTopLevel: top }))
    const planned = value(planBreakpoints(input))
    expect(planned).toEqual({ selectedAuto: [0], topLevel: Option.some({ type: "ephemeral" }) })
    expect(Option.getOrThrow(planned.topLevel)).toBe(top)
    expect(input.positions).toBe(positions)
    expect(positions[1]).toEqual(caller({ type: "ephemeral", ttl: "5m" }))
    expect(final).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(top).toEqual({ type: "ephemeral" })
  })

  test("caller TTL order is validated even when framework caching is Off", () => {
    expect(value(plan([caller(control("1h")), caller(control("5m"))], { policy: { _tag: "Off" } }))).toEqual({ selectedAuto: [], topLevel: Option.none() })
    expect(failure(plan([caller(control()), caller(control("1h"))], { policy: { _tag: "Off" } }))).toEqual({ reason: "TtlOrder", message: "Place one-hour prompt cache controls before five-minute controls." })
    expect(value(plan([caller(control("1h")), auto(0), unmarked]))).toEqual({ selectedAuto: [1], topLevel: Option.none() })
  })

  test("automatic choices skip incompatible TTL positions without promoting or changing callers", () => {
    expect(value(plan([auto(0), caller(control("1h")), auto(1)]))).toEqual({ selectedAuto: [2], topLevel: Option.none() })
    expect(value(plan([auto(1), caller(control("5m")), auto(0)], { policy: { _tag: "Auto", ttl: "1h" } }))).toEqual({ selectedAuto: [0], topLevel: Option.none() })
    expect(value(plan([caller(control("5m")), auto(0)], { policy: { _tag: "Auto", ttl: "1h" } }))).toEqual({ selectedAuto: [], topLevel: Option.none() })
  })

  test("Off adds nothing but retains a valid caller top-level object", () => {
    const top = control("1h")
    const planned = value(plan([auto(0), unmarked], { policy: { _tag: "Off" }, callerTopLevel: top }))
    expect(planned).toEqual({ selectedAuto: [], topLevel: Option.some(top) })
    expect(Option.getOrThrow(planned.topLevel)).toBe(top)
  })

  test("capability false suppresses every policy but rejects non-null caller controls", () => {
    ;[{ _tag: "Auto", ttl: "5m" }, { _tag: "TopLevel", ttl: "1h" }, { _tag: "Off" }].forEach((policy) => {
      expect(value(plan([auto(0), unmarked], { policy: policy as BreakpointInput["policy"], capability: false }))).toEqual({ selectedAuto: [], topLevel: Option.none() })
    })
    expect(failure(plan([caller(control())], { capability: false }))).toEqual({ reason: "Capability", message: "This Messages endpoint does not support prompt cache controls." })
    expect(failure(plan([unmarked], { capability: false, callerTopLevel: control() })).reason).toBe("Capability")
    expect(value(plan([caller(null), caller(undefined)], { capability: false, callerTopLevel: null }))).toEqual({ selectedAuto: [], topLevel: Option.none() })
  })

  test("malformed block and top-level controls fail locally in every framework mode", () => {
    const malformed = [false, 0, "ephemeral", {}, [], { type: "persistent" }, { type: "ephemeral", ttl: "10m" }, { type: "ephemeral", ttl: null }, { type: "ephemeral", extra: "unsupported" }]
    malformed.forEach((unknown) => {
      expect(failure(plan([caller(unknown)], { policy: { _tag: "Off" } }))).toEqual({ reason: "Control", message: "A prompt cache control must be ephemeral with an optional five-minute or one-hour lifetime." })
      expect(failure(plan([unmarked], { callerTopLevel: unknown })).reason).toBe("Control")
    })
    expect(value(plan([caller(null), caller(undefined)]))).toEqual({ selectedAuto: [], topLevel: Option.none() })
    expect(value(plan([unmarked], { callerTopLevel: null }))).toEqual({ selectedAuto: [], topLevel: Option.none() })
  })

  test("caller controls require own enumerable data fields that serialize as validated", () => {
    const inherited = Object.create({ type: "ephemeral", ttl: "1h" })
    const inheritedSerializer = Object.assign(Object.create({ toJSON: () => ({ type: "ephemeral", ttl: "1h" }) }), { type: "ephemeral", ttl: "5m" })
    const hiddenType = Object.defineProperty({}, "type", { value: "ephemeral", enumerable: false })
    const hiddenTtl = Object.defineProperty({ type: "ephemeral" }, "ttl", { value: "1h", enumerable: false })
    const hiddenSerializer = Object.defineProperty({ type: "ephemeral", ttl: "5m" }, "toJSON", { value: () => ({ type: "ephemeral", ttl: "1h" }), enumerable: false })
    ;[inherited, inheritedSerializer, hiddenType, hiddenTtl, hiddenSerializer].forEach((invalid) => {
      expect(failure(plan([caller(invalid)], { policy: { _tag: "Off" } })).reason).toBe("Control")
      expect(failure(plan([unmarked], { callerTopLevel: invalid })).reason).toBe("Control")
    })
  })

  test("rejecting accessors does not evaluate caller getters or serializer hooks", () => {
    const reads: Array<string> = []
    const typeGetter = Object.defineProperty({}, "type", { enumerable: true, get: () => { reads.push("type"); return "ephemeral" } })
    const ttlGetter = Object.defineProperty({ type: "ephemeral" }, "ttl", { enumerable: true, get: () => { reads.push("ttl"); return "1h" } })
    const serializerGetter = Object.defineProperty({ type: "ephemeral" }, "toJSON", { enumerable: false, get: () => { reads.push("toJSON"); return () => ({ type: "ephemeral", ttl: "1h" }) } })
    ;[typeGetter, ttlGetter, serializerGetter].forEach((invalid) => {
      expect(failure(plan([caller(invalid)])).reason).toBe("Control")
      expect(failure(plan([unmarked], { callerTopLevel: invalid })).reason).toBe("Control")
    })
    expect(reads).toEqual([])
  })

  test("ordinary and null-prototype data controls retain identity without normalization", () => {
    const noPrototype = Object.assign(Object.create(null), { type: "ephemeral", ttl: "1h" })
    const planned = value(plan([unmarked], { callerTopLevel: noPrototype }))
    expect(Option.getOrThrow(planned.topLevel)).toBe(noPrototype)
    expect(planned).toEqual({ selectedAuto: [], topLevel: Option.some({ type: "ephemeral", ttl: "1h" }) })
    expect(Object.getPrototypeOf(noPrototype)).toBeNull()
    expect(value(plan([caller(Object.freeze(control("1h"))), auto(0)]))).toEqual({ selectedAuto: [1], topLevel: Option.none() })
  })

  test("TopLevel uses the actual final eligible block, including an unmarked volatile tail", () => {
    expect(value(plan([auto(0), unmarked], { policy: { _tag: "TopLevel", ttl: "1h" } }))).toEqual({ selectedAuto: [], topLevel: Option.some(control("1h")) })
    expect(failure(plan([], { policy: { _tag: "TopLevel", ttl: "5m" } }))).toEqual({ reason: "TopLevel", message: "A top-level prompt cache control needs a cacheable request block." })
    expect(failure(plan([], { callerTopLevel: control() })).reason).toBe("TopLevel")
  })

  test("caller top-level wins over configured TTL and matching final controls occupy one slot", () => {
    const top = control("5m")
    const planned = value(plan([caller(control("1h")), caller(control()), caller(control()), caller(control())], { policy: { _tag: "TopLevel", ttl: "1h" }, callerTopLevel: top }))
    expect(planned).toEqual({ selectedAuto: [], topLevel: Option.some(top) })
    expect(Option.getOrThrow(planned.topLevel)).toBe(top)
    expect(failure(plan([caller(control("1h"))], { callerTopLevel: control() }))).toEqual({ reason: "TopLevel", message: "The top-level prompt cache control must match the final block's lifetime." })
  })

  test("top-level consumes its final slot, counts capacity and participates in TTL order", () => {
    expect(failure(plan([caller(control()), caller(control()), caller(control()), caller(control()), unmarked], { policy: { _tag: "TopLevel", ttl: "5m" } })).reason).toBe("Capacity")
    expect(failure(plan([caller(control()), unmarked], { policy: { _tag: "TopLevel", ttl: "1h" } })).reason).toBe("TtlOrder")
    expect(value(plan([auto(0), auto(1), auto(2), auto(0), auto(0)], { callerTopLevel: control() }))).toEqual({ selectedAuto: [0, 1, 3], topLevel: Option.some(control()) })
    expect(value(plan([auto(0), auto(1)], { callerTopLevel: control("1h") }))).toEqual({ selectedAuto: [], topLevel: Option.some(control("1h")) })
    expect(value(plan([auto(0)], { callerTopLevel: control() }))).toEqual({ selectedAuto: [], topLevel: Option.some(control()) })
  })

  test("successful plans preserve callers, never exceed four slots and keep longer TTLs first", () => {
    const position = fc.oneof(fc.constant(unmarked), fc.integer({ min: 0, max: 2 }).map(auto), fc.constantFrom(control(), control("5m"), control("1h")).map(caller))
    fc.assert(fc.property(fc.array(position, { maxLength: 8 }), fc.constantFrom<PromptCacheTtl>("5m", "1h"), fc.option(fc.constantFrom(control(), control("1h")), { nil: undefined }), (positions, ttl, top) => {
      const input = request(positions, { policy: { _tag: "Auto", ttl }, callerTopLevel: top })
      const result = planBreakpoints(input)
      expect(planBreakpoints(input)).toEqual(result)
      // An independent exhaustive oracle establishes that the greedy planner finds the
      // best valid subset, rather than merely returning an always-empty safe plan.
      const candidates = positions.flatMap((position, index) => position._tag === "Auto" && !(top !== undefined && index === positions.length - 1) ? [{ index, priority: position.priority }] : []).toSorted((left, right) => left.priority - right.priority || right.index - left.index)
      const subsets = Array.from({ length: 2 ** candidates.length }, (_, mask) => candidates.flatMap((candidate, rank) => mask & (1 << (candidates.length - rank - 1)) ? [candidate.index] : [])).reverse()
      const markersFor = (selected: ReadonlyArray<number>) => positions.flatMap((position, index) => {
        if (index === positions.length - 1 && top !== undefined) return [top.ttl ?? "5m"]
        if (position._tag === "Caller") return [(position.control as PromptCacheControl).ttl ?? "5m"]
        return selected.includes(index) ? [ttl] : []
      })
      const final = positions[positions.length - 1]
      const conflict = top !== undefined && (positions.length === 0 || (final?._tag === "Caller" && ((final.control as PromptCacheControl).ttl ?? "5m") !== (top.ttl ?? "5m")))
      const oracle = conflict ? undefined : subsets.find((selected) => {
        const markers = markersFor(selected)
        return markers.length <= 4 && (!markers.includes("5m") || markers.lastIndexOf("1h") < markers.indexOf("5m"))
      })
      expect(Result.isSuccess(result)).toBe(oracle !== undefined)
      if (Result.isFailure(result) || oracle === undefined) return
      const planned = result.success
      expect(planned.selectedAuto).toEqual(oracle.toSorted((left, right) => left - right))
      expect(Schema.is(BreakpointPlan)(planned)).toBe(true)
      expect(new Set(planned.selectedAuto).size).toBe(planned.selectedAuto.length)
      expect(planned.selectedAuto.every((index) => positions[index]?._tag === "Auto")).toBe(true)
      const markers = markersFor(planned.selectedAuto)
      expect(markers.length).toBeLessThanOrEqual(4)
      expect(markers.lastIndexOf("1h") < markers.indexOf("5m") || !markers.includes("5m")).toBe(true)
      if (top !== undefined) expect(Option.getOrThrow(planned.topLevel)).toBe(top)
    }), { numRuns: 600, seed: 15 })
  })
})
