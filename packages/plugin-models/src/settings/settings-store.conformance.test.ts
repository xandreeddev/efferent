import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Schema, SynchronizedRef } from "effect"
import { parseModelSelection } from "@xandreed/core"
import { EngineSettings, SettingsError, SettingsStore } from "../ports/settings-store.port.js"
import type { ModelRole, SettingsKey } from "../ports/settings-store.port.js"
import { settingsStoreConformance } from "./settings-store.conformance.js"
import type { SettingsStoreSubject } from "./settings-store.conformance.js"

type Store = typeof SettingsStore.Service

const ROLE_FIELDS = { general: "model", code: "codeModel", fast: "fastModel" } as const

/** A key's string form, coerced the way a store must: the value it stores, or why it refuses it. */
const coerce = (key: SettingsKey, raw: string): Effect.Effect<unknown, SettingsError> => {
  const refuse = Effect.fail(new SettingsError({ message: `${key}: "${raw}"` }))
  if (key === "fallbackModel") return Option.isSome(parseModelSelection(raw)) ? Effect.succeed(raw) : refuse
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

const failedChecks = (subject: SettingsStoreSubject) => Effect.runPromise(Effect.forEach(settingsStoreConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])), { concurrency: 1 }).pipe(Effect.map((failed) => failed.flat().toSorted())))
const subjectOf = (alter: (store: Store) => Store = (store) => store, writable = true): SettingsStoreSubject => ({
  writable, open: () => reference(seeded).pipe(Effect.map((store) => ({ store: alter(store) }))),
})

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

const seeded = new EngineSettings({ model: Option.some("seed:general"), fastModel: Option.some("seed:fast"), maxAttempts: Option.some(7), budgetMillis: Option.some(30_000) })

describe("the SettingsStore kit", () => {
  settingsStoreConformance(subjectOf()).map((check) => test(check.name, async () => {
    expect((await Effect.runPromise(Effect.result(check.run)))._tag).toBe("Success")
  }))

  test("each check opens its own fixture, in either order", async () => {
    const opened = { count: 0 }
    const subject: SettingsStoreSubject = { writable: true, open: () => reference(seeded).pipe(Effect.tap(() => Effect.sync(() => { opened.count++ })), Effect.map((store) => ({ store }))) }
    const checks = settingsStoreConformance(subject)
    for (const order of [checks, [...checks].reverse()]) for (const check of order) expect((await Effect.runPromise(Effect.result(check.run)))._tag).toBe("Success")
    expect(opened.count).toBe(checks.length * 2)
  })

  test("read-only adapters refuse every write", async () => {
    expect(await failedChecks(subjectOf((store) => ({ ...store, setRole: () => Effect.fail(new SettingsError({ message: "read-only" })), set: () => Effect.fail(new SettingsError({ message: "read-only" })) }), false))).toEqual([])
  })

  test.each(["fail", "defaults"] as const)("corruption probes reject a store that answers %s", async (mode) => {
    const subject: SettingsStoreSubject = { writable: true, corrupt: true, open: () => damageable(mode, seeded).pipe(Effect.map(({ store, corrupt }) => ({ store, corruptions: [corrupt] }))) }
    expect(await failedChecks(subject)).toEqual(mode === "fail" ? [] : ["corrupt"])
  })
})

describe("careless settings adapters", () => {
  test("accepting invalid values fails bad-values", async () => {
    expect(await failedChecks(subjectOf((store) => ({ ...store, set: (key, value) => store.set(key, value).pipe(Effect.catchTag("SettingsError", () => Effect.void)) })))).toEqual(["bad-values"])
  })
  test("accepting invalid role selections fails bad-role", async () => {
    expect(await failedChecks(subjectOf((store) => ({ ...store, setRole: (role, value) => Option.isSome(value) && Option.isNone(parseModelSelection(value.value)) ? Effect.void : store.setRole(role, value) })))).toEqual(["bad-role"])
  })
  test("ignoring clear fails both role and clear", async () => {
    expect(await failedChecks(subjectOf((store) => ({ ...store, setRole: (role, value) => Option.isNone(value) ? Effect.void : store.setRole(role, value), set: (key, value) => Option.isNone(value) ? Effect.void : store.set(key, value) })))).toEqual(["clear", "role"])
  })
  test("a fixture that supplies corruption probes its subject does not declare fails every check, rather than skipping them", async () => {
    const subject: SettingsStoreSubject = { writable: true, open: () => damageable("defaults", seeded).pipe(Effect.map(({ store, corrupt }) => ({ store, corruptions: [corrupt] }))) }
    expect(await failedChecks(subject)).toEqual(["bad-role", "bad-values", "clear", "load", "role", "values"])
  })
  test("silently accepting read-only writes fails read-only", async () => {
    expect(await failedChecks(subjectOf((store) => ({ ...store, setRole: () => Effect.void, set: () => Effect.void }), false))).toEqual(["read-only"])
  })
})
