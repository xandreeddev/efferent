import { Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import { canonicalJson, harnessCodeOf } from "@xandreed/core"
import { check, ConformanceFailure } from "@xandreed/core/conformance"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import { randomUuid } from "@xandreed/core/internal"
import { SETTINGS_KEYS } from "../ports/settings-store.port.js"
import type { EngineSettings, ModelRole, SettingsKey, SettingsStore } from "../ports/settings-store.port.js"

type Store = Context.Service.Shape<typeof SettingsStore>

const fail = (id: string, message: string) => Effect.fail(new ConformanceFailure({ check: id, message }))
const expect = (id: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(id, message)
type Field = keyof Pick<EngineSettings, "model" | "codeModel" | "fastModel" | SettingsKey>

const ROLE_FIELDS: Readonly<Record<ModelRole, Field>> = { general: "model", code: "codeModel", fast: "fastModel" }
const ROLES: ReadonlyArray<ModelRole> = ["general", "code", "fast"]
const FIELDS: ReadonlyArray<Field> = ["model", "codeModel", "fastModel", ...SETTINGS_KEYS]

/** One field's value, whatever its type. */
const fieldOf = (settings: EngineSettings, field: Field): Option.Option<unknown> => settings[field]
/** One field's value as text: what a setter takes back (`true`, `3`, `provider:model`). */
const valueOf = (settings: EngineSettings, field: Field): Option.Option<string> => Option.map(fieldOf(settings, field), String)
/** Every field, as one comparable string. */
const snapshot = (settings: EngineSettings): string => canonicalJson(Object.fromEntries(FIELDS.map((field) => [field, Option.getOrNull(valueOf(settings, field))])))
/** Every field but `except`, as one comparable string. */
const others = (settings: EngineSettings, except: Field): string =>
  canonicalJson(Object.fromEntries(FIELDS.filter((field) => field !== except).map((field) => [field, Option.getOrNull(valueOf(settings, field))])))
/** A selection no real store holds, so the kit can run against a shared store. */
const selection = (label: string): Effect.Effect<string> => Effect.map(randomUuid, (id) => `conformance:${label}-${id}`)

/** `write` must fail with a SettingsError and leave every value as it was. */
const refused = (store: Store, id: string, what: string, write: Effect.Effect<void, unknown>) => Effect.gen(function* () {
  const before = snapshot(yield* store.load)
  const result = yield* Effect.result(write)
  if (result._tag === "Success") return yield* fail(id, `${what} was accepted`)
  const tag = typeof result.failure === "object" && result.failure !== null && "_tag" in result.failure ? String(result.failure._tag) : "an error"
  yield* expect(id, tag === "SettingsError", `${what} failed with ${tag}, not a SettingsError`)
  yield* expect(id, snapshot(yield* store.load) === before, `${what} changed the settings`)
})

/** Each non-role key the kit writes, the canonical string it writes and the value `load` must then give. */
const CANONICAL: ReadonlyArray<{ readonly key: SettingsKey; readonly text: string; readonly reads: unknown }> = [
  { key: "maxAttempts", text: "3", reads: 3 },
  { key: "budgetMillis", text: "60000", reads: 60000 },
  { key: "reasoningEffort", text: "high", reads: "high" },
]

/** Each key the clear check writes, with two canonical values it can choose from. */
const CLEARED: ReadonlyArray<{ readonly key: SettingsKey; readonly texts: readonly [string, string] }> = [
  { key: "maxAttempts", texts: ["4", "5"] },
  { key: "budgetMillis", texts: ["1000", "2000"] },
  { key: "reasoningEffort", texts: ["low", "medium"] },
]

/** Values no store may accept, as `set` and `setRole` receive them. */
const BAD: ReadonlyArray<{ readonly key: SettingsKey; readonly text: string }> = [
  { key: "fallbackModel", text: "not-a-selection" },
  { key: "maxAttempts", text: "0" },
  { key: "maxAttempts", text: "two" },
  { key: "budgetMillis", text: "1.5" },
  { key: "reasoningEffort", text: "extreme" },
]

/** A fresh, scoped fixture per check. Its backing tiers may each supply a corruption probe. @public */
export interface SettingsStoreSubject {
  readonly writable: boolean
  readonly corrupt?: boolean
  readonly open: () => Effect.Effect<{
    readonly store: Store
    readonly corruptions?: ReadonlyArray<Effect.Effect<void, never, Scope.Scope>>
  }, unknown, Scope.Scope>
}

type CaseBuilder = (name: string, id: string, body: (store: Store) => Effect.Effect<void, unknown>) => ConformanceCheck

/** `effect` must fail with a `SettingsError` of code `settings.corrupt`. */
const corrupted = (what: string, effect: Effect.Effect<unknown, unknown>) => Effect.result(effect).pipe(Effect.flatMap((result) => {
  if (result._tag === "Success") return fail("corrupt", `${what} succeeded on a store whose backing data cannot be read`)
  const error: unknown = result.failure
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "an error"
  const code = Option.getOrElse(harnessCodeOf(error), () => "no code")
  return expect("corrupt", tag === "SettingsError" && code === "settings.corrupt", `${what} failed with ${tag} (${code}), not a SettingsError of code settings.corrupt`)
}))

const corruptCheck = (store: Store, writable: boolean, corrupt: Effect.Effect<void, never, Scope.Scope>): ConformanceCheck =>
  check("a store whose backing data cannot be read fails load and every write with a SettingsError of code settings.corrupt, never reads it as defaults", "corrupt", () => {
    const body = Effect.gen(function* () {
      const before = snapshot(yield* store.load)
      yield* Effect.scoped(Effect.gen(function* () {
        yield* corrupt
        yield* corrupted("load", store.load)
        yield* writable ? Effect.all([
          selection("corrupt").pipe(Effect.flatMap((value) => corrupted("setRole", store.setRole("general", Option.some(value))))),
          corrupted("set", store.set("maxAttempts", Option.some("3"))),
        ], { concurrency: 1, discard: true }) : Effect.void
      }))
      yield* expect("corrupt", snapshot(yield* store.load) === before, "once the backing data is repaired, the store does not read what it held before")
    })
    // A write that ignored the damage is put back like any other.
    return body
  })

/**
 * Prove reads, writes, clearing, refusal and corruption against a fresh fixture
 * for each check. The fixture owns its stores and cleanup. The kit never tries
 * to restore merged effective settings into a writable tier.
 * @public
 */
export const settingsStoreConformance = (subject: SettingsStoreSubject): ReadonlyArray<ConformanceCheck> => {
  const caseOf: CaseBuilder = (name, id, body) => check(name, id, () => Effect.scoped(subject.open().pipe(Effect.flatMap(({ store }) => body(store)))))
  return [
    caseOf("load is stable: two loads with no write between them agree", "load", (store) => Effect.gen(function* () {
      const first = snapshot(yield* store.load)
      yield* expect("load", snapshot(yield* store.load) === first, "two loads disagree")
    })),
    ...(subject.writable ? writableChecks(caseOf) : readOnlyChecks(caseOf)),
    ...(subject.corrupt ? [check("every backing tier refuses corrupt data without changing settings", "corrupt", () => Effect.scoped(Effect.gen(function* () {
      const fixture = yield* subject.open()
      const probes = fixture.corruptions ?? []
      yield* expect("corrupt", probes.length > 0, "the subject declares corruption checks but supplies no probes")
      yield* Effect.forEach(probes, (probe) => corruptCheck(fixture.store, subject.writable, probe).run, { concurrency: 1, discard: true })
    })))] : []),
  ]
}

const writableChecks = (caseOf: CaseBuilder): ReadonlyArray<ConformanceCheck> => [
  caseOf("each role reads back what setRole wrote, and clearing it returns the value before the set", "role", (store) => Effect.forEach(ROLES, (role) => Effect.gen(function* () {
    const field = ROLE_FIELDS[role]
    yield* store.setRole(role, Option.none())
    const base = yield* store.load
    const value = yield* selection(role)
    yield* store.setRole(role, Option.some(value))
    const set = yield* store.load
    yield* expect("role", Option.getOrUndefined(valueOf(set, field)) === value, `the ${role} role reads ${Option.getOrElse(valueOf(set, field), () => "nothing")}, not what was set`)
    yield* expect("role", others(set, field) === others(base, field), `setting the ${role} role changed another value`)
    yield* store.setRole(role, Option.none())
    yield* expect("role", snapshot(yield* store.load) === snapshot(base), `clearing the ${role} role did not return the value before the set`)
  }), { concurrency: 1, discard: true })),
  caseOf("set accepts each key's canonical string form and load reads it back typed", "values", (store) => selection("fallback").pipe(Effect.flatMap((fallback) => Effect.forEach([
    ...CANONICAL,
    { key: "fallbackModel" as const, text: fallback, reads: undefined },
  ], ({ key, text, reads }) => Effect.gen(function* () {
    const before = yield* store.load
    yield* store.set(key, Option.some(text))
    const after = yield* store.load
    const expected = reads ?? text
    const read = Option.getOrNull(fieldOf(after, key))
    yield* expect("values", read === expected, `${key} "${text}" reads back as ${JSON.stringify(read)}`)
    yield* expect("values", others(after, key) === others(before, key), `setting ${key} changed another value`)
  }), { concurrency: 1, discard: true })))),
  caseOf("None clears a key back to the value before the set", "clear", (store) => Effect.forEach(CLEARED, ({ key, texts }) => Effect.gen(function* () {
    yield* store.set(key, Option.none())
    const base = yield* store.load
    // A value the key does not hold already, so a clear that changes nothing shows.
    const text = texts.find((candidate) => Option.getOrNull(valueOf(base, key)) !== candidate) ?? texts[0]!
    yield* store.set(key, Option.some(text))
    yield* store.set(key, Option.none())
    yield* expect("clear", snapshot(yield* store.load) === snapshot(base), `clearing ${key} did not return the value before the set`)
  }), { concurrency: 1, discard: true })),
  caseOf("set refuses a value that does not parse with a SettingsError and changes nothing", "bad-values", (store) => Effect.forEach(BAD, ({ key, text }) =>
    refused(store, "bad-values", `${key} "${text}"`, store.set(key, Option.some(text))), { concurrency: 1, discard: true })),
  caseOf("setRole refuses a selection that is not \"<provider>:<modelId>\" with a SettingsError and changes nothing", "bad-role", (store) => Effect.forEach(ROLES, (role) =>
    Effect.forEach(["not-a-selection", ":model", "provider:"], (text) => refused(store, "bad-role", `the ${role} role "${text}"`, store.setRole(role, Option.some(text))), { concurrency: 1, discard: true })
      , { concurrency: 1, discard: true })),
]

const readOnlyChecks = (caseOf: CaseBuilder): ReadonlyArray<ConformanceCheck> => [
  caseOf("a read-only store refuses every write with a SettingsError and changes nothing", "read-only", (store) => Effect.gen(function* () {
    yield* Effect.forEach(ROLES, (role) => Effect.all([
      selection(role).pipe(Effect.flatMap((value) => refused(store, "read-only", `setRole ${role}`, store.setRole(role, Option.some(value))))),
      refused(store, "read-only", `clearing the ${role} role`, store.setRole(role, Option.none())),
    ], { concurrency: 1 }), { concurrency: 1, discard: true })
    yield* Effect.forEach(CANONICAL, ({ key, text }) => Effect.all([
      refused(store, "read-only", `set ${key}`, store.set(key, Option.some(text))),
      refused(store, "read-only", `clearing ${key}`, store.set(key, Option.none())),
    ], { concurrency: 1 }), { concurrency: 1, discard: true })
  })),
]
