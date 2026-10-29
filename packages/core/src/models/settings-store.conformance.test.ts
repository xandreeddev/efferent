import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Schema, SynchronizedRef } from "effect"
import { parseModelSelection } from "../domain/model-selection.entity.functions.js"
import { EngineSettings, SettingsError, SettingsStore } from "../ports/settings-store.port.js"
import type { ModelRole, SettingsKey } from "../ports/settings-store.port.js"
import { settingsStoreConformance } from "./settings-store.conformance.js"
import type { SettingsStoreConformanceOptions } from "./settings-store.conformance.js"

type Store = typeof SettingsStore.Service

const ROLE_FIELDS = { general: "model", code: "codeModel", fast: "fastModel" } as const

/** A key's string form, coerced the way a store must: the value it stores, or why it refuses it. */
const coerce = (key: SettingsKey, raw: string): Effect.Effect<unknown, SettingsError> => {
  const refuse = Effect.fail(new SettingsError({ message: `${key}: "${raw}"` }))
  if (key === "fallbackModel") return Option.isSome(parseModelSelection(raw)) ? Effect.succeed(raw) : refuse
  if (key === "sandbox" || key === "viMode") return raw === "true" ? Effect.succeed(true) : raw === "false" ? Effect.succeed(false) : refuse
  if (key === "reasoningEffort" || key === "codeReasoningEffort" || key === "fastReasoningEffort") {
    return ["none", "low", "medium", "high", "xhigh", "max"].includes(raw) ? Effect.succeed(raw) : refuse
  }
  return Number.isInteger(Number(raw)) && Number(raw) >= 1 ? Effect.succeed(Number(raw)) : refuse
}

/** One field written (or dropped) through the settings' encoded form. */
const withField = (settings: EngineSettings, field: string, value: Option.Option<unknown>) => {
  const encoded = Object.fromEntries(Object.entries(Schema.encodeSync(EngineSettings)(settings)).filter(([key]) => key !== field))
  return Schema.decodeUnknownEffect(EngineSettings)(Option.match(value, { onNone: () => encoded, onSome: (set) => ({ ...encoded, [field]: set }) })).pipe(
    Effect.mapError((error) => new SettingsError({ message: String(error) })),
  )
}

/** A minimal writable store that keeps the contract: one value in a SynchronizedRef. */
const reference = (initial = new EngineSettings({})) => Effect.gen(function* () {
  const state = yield* SynchronizedRef.make(initial)
  const setRole = (role: ModelRole, selection: Option.Option<string>) => SynchronizedRef.updateEffect(state, (settings) =>
    Option.isSome(selection) && Option.isNone(parseModelSelection(selection.value))
      ? Effect.fail(new SettingsError({ message: `${role}: "${selection.value}"` }))
      : withField(settings, ROLE_FIELDS[role], selection))
  return SettingsStore.of({
    load: SynchronizedRef.get(state),
    setRole,
    set: (key, value) => SynchronizedRef.updateEffect(state, (settings) => Option.match(value, {
      onNone: () => withField(settings, key, Option.none()),
      onSome: (raw) => coerce(key, raw).pipe(Effect.flatMap((coerced) => withField(settings, key, Option.some(coerced)))),
    })),
  })
})

const failedChecks = (store: Store, writable: boolean, options: Partial<SettingsStoreConformanceOptions> = {}) => Effect.runPromise(Effect.forEach(settingsStoreConformance(store, { writable, ...options }), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))).pipe(Effect.map((failed) => failed.flat().toSorted())))

/**
 * The reference store over backing data the kit can damage: while damaged,
 * it fails every call with `settings.corrupt`, or (`damaged: "defaults"`)
 * reads defaults and writes over it.
 */
const damageable = (damaged: "fail" | "defaults", initial = new EngineSettings({})) => Effect.gen(function* () {
  const store = yield* reference(initial)
  const isDamaged = yield* Ref.make(false)
  const readable = <A>(effect: Effect.Effect<A, SettingsError>, fallback: Effect.Effect<A, SettingsError>) => Ref.get(isDamaged).pipe(Effect.flatMap((now) =>
    !now ? effect
      : damaged === "fail" ? Effect.fail(new SettingsError({ code: "settings.corrupt", message: "the data is damaged" }))
      : fallback))
  return {
    store: SettingsStore.of({
      load: readable(store.load, Effect.succeed(new EngineSettings({}))),
      setRole: (role, value) => readable(store.setRole(role, value), store.setRole(role, value)),
      set: (key, value) => readable(store.set(key, value), store.set(key, value)),
    }),
    corrupt: Effect.acquireRelease(Ref.set(isDamaged, true), () => Ref.set(isDamaged, false)),
  }
})

const seeded = new EngineSettings({ model: Option.some("seed:general"), fastModel: Option.some("seed:fast"), maxAttempts: Option.some(7), sandbox: Option.some(false) })

describe("the SettingsStore kit", () => {
  const store = Effect.runSync(reference(seeded))
  settingsStoreConformance(store, { writable: true }).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))

  test("puts back every key it touched", async () => {
    await failedChecks(store, true)
    expect(Schema.encodeSync(EngineSettings)(await Effect.runPromise(store.load))).toEqual(Schema.encodeSync(EngineSettings)(seeded))
  })

  test("refuses to touch a key holding a value it could not put back, and leaves it as it was", async () => {
    const legacy = new EngineSettings({ model: Option.some("sonnet"), maxAttempts: Option.some(0), sandbox: Option.some(true) })
    const store = Effect.runSync(reference(legacy))
    expect(await failedChecks(store, true)).toEqual(["bad-role", "bad-values", "clear", "role", "values"])
    expect(Schema.encodeSync(EngineSettings)(await Effect.runPromise(store.load))).toEqual(Schema.encodeSync(EngineSettings)(legacy))
  })

  test("a store that fails on damaged data passes the corrupt check, writable or read-only", async () => {
    const writable = Effect.runSync(damageable("fail", seeded))
    expect(await failedChecks(writable.store, true, { corrupt: writable.corrupt })).toEqual([])
    const readOnly = Effect.runSync(damageable("fail", seeded))
    const refusing = SettingsStore.of({ ...readOnly.store, setRole: () => Effect.fail(new SettingsError({ message: "read-only" })), set: () => Effect.fail(new SettingsError({ message: "read-only" })) })
    expect(await failedChecks(refusing, false, { corrupt: readOnly.corrupt })).toEqual([])
  })

  test("a read-only store passes the read-only checks", async () => {
    const store = Effect.runSync(reference(seeded))
    const readOnly = SettingsStore.of({
      load: store.load,
      setRole: () => Effect.fail(new SettingsError({ message: "read-only" })),
      set: () => Effect.fail(new SettingsError({ message: "read-only" })),
    })
    expect(await failedChecks(readOnly, false)).toEqual([])
  })
})

describe("the SettingsStore kit catches stores that break the contract", () => {
  test("a set that ignores a value it cannot parse fails the bad-values check", async () => {
    const store = Effect.runSync(reference())
    const lenient = SettingsStore.of({ ...store, set: (key, value) => store.set(key, value).pipe(Effect.catchTag("SettingsError", () => Effect.void)) })
    expect(await failedChecks(lenient, true)).toEqual(["bad-values"])
  })

  test("a setRole that stores any text fails the bad-role check", async () => {
    const store = Effect.runSync(reference())
    const unchecked = SettingsStore.of({
      ...store,
      setRole: (role, selection) => Option.match(selection, {
        onNone: () => store.setRole(role, selection),
        onSome: (text) => Option.isSome(parseModelSelection(text)) ? store.setRole(role, selection) : Effect.void,
      }),
    })
    expect(await failedChecks(unchecked, true)).toEqual(["bad-role"])
  })

  test("a store whose None does not clear fails the role and clear checks", async () => {
    const store = Effect.runSync(reference())
    const sticky = SettingsStore.of({
      ...store,
      setRole: (role, selection) => Option.isNone(selection) ? Effect.void : store.setRole(role, selection),
      set: (key, value) => Option.isNone(value) ? Effect.void : store.set(key, value),
    })
    expect(await failedChecks(sticky, true)).toEqual(["clear", "role"])
  })

  test("a store that reads damaged data as defaults fails the corrupt check, and is left as it was", async () => {
    const { store, corrupt } = Effect.runSync(damageable("defaults", seeded))
    expect(await failedChecks(store, true, { corrupt })).toEqual(["corrupt"])
    expect(Schema.encodeSync(EngineSettings)(await Effect.runPromise(store.load))).toEqual(Schema.encodeSync(EngineSettings)(seeded))
  })

  test("a read-only store that accepts writes silently fails the read-only check", async () => {
    const store = Effect.runSync(reference())
    expect(await failedChecks(SettingsStore.of({ load: store.load, setRole: () => Effect.void, set: () => Effect.void }), false)).toEqual(["read-only"])
  })
})
