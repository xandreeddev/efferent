import { Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail } from "../conformance.functions.js"
import { parseModelSelection } from "../domain/model-selection.entity.functions.js"
import { harnessCodeOf } from "../harness/harness-code.entity.functions.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { SETTINGS_KEYS } from "../ports/settings-store.port.js"
import type { EngineSettings, ModelRole, SettingsKey, SettingsStore } from "../ports/settings-store.port.js"
import { randomUuid } from "../util/random-id.js"

type Store = Context.Service.Shape<typeof SettingsStore>
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

const SELECTIONS: ReadonlySet<Field> = new Set(["model", "codeModel", "fastModel", "fallbackModel"])
const COUNTS: ReadonlySet<Field> = new Set(["maxAttempts"])

/**
 * Whether the kit can write `value` back to `field`: not a value the
 * contract makes every writable store refuse (a selection that is not
 * `"<provider>:<modelId>"`, a count below 1), as a store may still hold one
 * written before it checked its values.
 */
const restorable = (field: Field, value: string): boolean =>
  SELECTIONS.has(field) ? Option.isSome(parseModelSelection(value))
    : COUNTS.has(field) ? Number.isInteger(Number(value)) && Number(value) >= 1
    : true

/**
 * Run `body`, then put `field` back as `load` read it before: the kit leaves
 * every key it touches as it found it. A field already equal to that value
 * is not written again, so a value read from a store's lower tier is not
 * copied into the tier it writes. A field holding a value the store would
 * refuse to write back fails check `id` before anything is written.
 */
const restoring = (store: Store, id: string, field: Field, write: (value: Option.Option<string>) => Effect.Effect<void, unknown>) =>
  <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | unknown> => store.load.pipe(Effect.flatMap((before) => Option.match(Option.filter(valueOf(before, field), (value) => !restorable(field, value)), {
    onSome: (value): Effect.Effect<A, unknown> => fail(id, `the store holds ${field} "${value}", which a conforming store refuses to write, so the kit could not put it back; it changed nothing. Correct the value, then run the kit`),
    onNone: (): Effect.Effect<A, unknown> => body.pipe(Effect.ensuring(store.load.pipe(
      Effect.flatMap((after) => Option.getOrNull(valueOf(after, field)) === Option.getOrNull(valueOf(before, field)) ? Effect.void : write(valueOf(before, field))),
      Effect.ignore({ log: "Warn", message: `the kit could not put back ${field}` }),
    ))),
  })))

const restoringRole = (store: Store, id: string, role: ModelRole) => restoring(store, id, ROLE_FIELDS[role], (value) => store.setRole(role, value))
const restoringKey = (store: Store, id: string, key: SettingsKey) => restoring(store, id, key, (value) => store.set(key, value))

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
  { key: "sandbox", text: "true", reads: true },
  { key: "reasoningEffort", text: "high", reads: "high" },
]

/** Each key the clear check writes, with two canonical values it can choose from. */
const CLEARED: ReadonlyArray<{ readonly key: SettingsKey; readonly texts: readonly [string, string] }> = [
  { key: "maxAttempts", texts: ["4", "5"] },
  { key: "sandbox", texts: ["false", "true"] },
  { key: "reasoningEffort", texts: ["low", "medium"] },
]

/** Values no store may accept, as `set` and `setRole` receive them. */
const BAD: ReadonlyArray<{ readonly key: SettingsKey; readonly text: string }> = [
  { key: "fallbackModel", text: "not-a-selection" },
  { key: "maxAttempts", text: "0" },
  { key: "maxAttempts", text: "two" },
  { key: "sandbox", text: "maybe" },
  { key: "reasoningEffort", text: "extreme" },
]

/** What the kit is told about a store, and can do to it beyond calling it. */
export interface SettingsStoreConformanceOptions {
  /** Whether `setRole` and `set` write, or every write is refused. */
  readonly writable: boolean
  /**
   * Damage the store's backing data (a file that is not JSON) for the
   * scope's lifetime, and repair it when the scope closes: the corrupt check.
   * Damage what the store writes to, so a write that ignores the damage shows.
   * A store with nothing to damage, such as one in memory, leaves it out.
   */
  readonly corrupt?: Effect.Effect<void, never, Scope.Scope>
}

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
    return writable ? body.pipe(restoringRole(store, "corrupt", "general"), restoringKey(store, "corrupt", "maxAttempts")) : body
  })

/**
 * The SettingsStore contract. Every store: `load` is stable. A writable
 * store: each role reads back what `setRole` wrote and clearing it returns
 * the value before the set; `set` accepts each key's canonical string form
 * and `load` gives it typed; `None` clears a key back to the value before the
 * set; a value that does not parse (a selection that is not
 * `"<provider>:<modelId>"`, a count below 1, a switch that is not
 * true/false, an unknown effort) fails with a `SettingsError` and changes
 * nothing, through `set` and `setRole` alike. A read-only store refuses
 * every write with a `SettingsError` and changes nothing.
 *
 * The kit writes the store's shared keys (settings have no per-check ids),
 * and restores each key it touches; do not run it against settings that are
 * in use. A key it would touch that holds a value the store must refuse (a
 * selection that is not `"<provider>:<modelId>"`, a count below 1, left by
 * an older, unchecked write) could not be put back, so the check that would
 * touch it fails before writing anything.
 *
 * With `options.corrupt`, a store whose backing data cannot be read fails
 * `load` (and, writable, `setRole` and `set`) with a `SettingsError` of code
 * `settings.corrupt` instead of reading it as defaults.
 */
export const settingsStoreConformance = (store: Store, options: SettingsStoreConformanceOptions): ReadonlyArray<ConformanceCheck> => [
  check("load is stable: two loads with no write between them agree", "load", () => Effect.gen(function* () {
    const first = snapshot(yield* store.load)
    yield* expect("load", snapshot(yield* store.load) === first, "two loads disagree")
  })),
  ...(options.writable ? writableChecks(store) : readOnlyChecks(store)),
  ...Option.match(Option.fromNullishOr(options.corrupt), { onNone: () => [], onSome: (corrupt) => [corruptCheck(store, options.writable, corrupt)] }),
]

const writableChecks = (store: Store): ReadonlyArray<ConformanceCheck> => [
  check("each role reads back what setRole wrote, and clearing it returns the value before the set", "role", () => Effect.forEach(ROLES, (role) => Effect.gen(function* () {
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
  }).pipe(restoringRole(store, "role", role)), { concurrency: 1, discard: true })),
  check("set accepts each key's canonical string form and load reads it back typed", "values", () => selection("fallback").pipe(Effect.flatMap((fallback) => Effect.forEach([
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
  }).pipe(restoringKey(store, "values", key)), { concurrency: 1, discard: true })))),
  check("None clears a key back to the value before the set", "clear", () => Effect.forEach(CLEARED, ({ key, texts }) => Effect.gen(function* () {
    yield* store.set(key, Option.none())
    const base = yield* store.load
    // A value the key does not hold already, so a clear that changes nothing shows.
    const text = texts.find((candidate) => Option.getOrNull(valueOf(base, key)) !== candidate) ?? texts[0]!
    yield* store.set(key, Option.some(text))
    yield* store.set(key, Option.none())
    yield* expect("clear", snapshot(yield* store.load) === snapshot(base), `clearing ${key} did not return the value before the set`)
  }).pipe(restoringKey(store, "clear", key)), { concurrency: 1, discard: true })),
  check("set refuses a value that does not parse with a SettingsError and changes nothing", "bad-values", () => Effect.forEach(BAD, ({ key, text }) =>
    refused(store, "bad-values", `${key} "${text}"`, store.set(key, Option.some(text))).pipe(restoringKey(store, "bad-values", key)), { concurrency: 1, discard: true })),
  check("setRole refuses a selection that is not \"<provider>:<modelId>\" with a SettingsError and changes nothing", "bad-role", () => Effect.forEach(ROLES, (role) =>
    Effect.forEach(["not-a-selection", ":model", "provider:"], (text) => refused(store, "bad-role", `the ${role} role "${text}"`, store.setRole(role, Option.some(text))), { concurrency: 1, discard: true })
      .pipe(restoringRole(store, "bad-role", role)), { concurrency: 1, discard: true })),
]

const readOnlyChecks = (store: Store): ReadonlyArray<ConformanceCheck> => [
  check("a read-only store refuses every write with a SettingsError and changes nothing", "read-only", () => Effect.gen(function* () {
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
