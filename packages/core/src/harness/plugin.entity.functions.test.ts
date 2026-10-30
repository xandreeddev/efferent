import { describe, expect, test } from "bun:test"
import { Context, Effect, Redacted, Ref, Schema } from "effect"
import { ActionPolicy, SessionEnvironment } from "../ports/harness.port.js"
import { mergeOptions, provideDeclared } from "./plugin.entity.functions.js"

const Ownership = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("lease"), ttlMs: Schema.Number, renew: Schema.Union([Schema.Literal("none"), Schema.Struct({ everyMs: Schema.Number })]) }),
  Schema.Struct({ mode: Schema.Literal("process") }),
])
const Config = Schema.Struct({
  ownership: Ownership,
  inbox: Schema.Struct({ maxPending: Schema.Number, attempts: Schema.Number }),
  roots: Schema.Array(Schema.String),
  prices: Schema.Record(Schema.String, Schema.Struct({ input: Schema.Number, output: Schema.Number })),
  secret: Schema.optional(Schema.Struct({ key: Schema.Redacted(Schema.String), label: Schema.String })),
  title: Schema.String,
})
const defaults: typeof Config.Type = {
  ownership: { mode: "lease", ttlMs: 60_000, renew: { everyMs: 20_000 } },
  inbox: { maxPending: 20, attempts: 2 },
  roots: ["a", "b"],
  prices: { small: { input: 1, output: 2 } },
  title: "t",
}
const merge = (options: object) => mergeOptions(Config, defaults, options)

describe("mergeOptions", () => {
  test("a nested object merges key by key over its default, at every depth", () => {
    expect(merge({ inbox: { maxPending: 50 } })).toEqual({ ...defaults, inbox: { maxPending: 50, attempts: 2 } })
    expect(merge({ ownership: { ttlMs: 120_000 } })).toEqual({ ...defaults, ownership: { mode: "lease", ttlMs: 120_000, renew: { everyMs: 20_000 } } })
    expect(merge({ ownership: { renew: { everyMs: 500 } } })).toMatchObject({ ownership: { renew: { everyMs: 500 } } })
    expect(merge({ prices: { large: { input: 3, output: 4 } } })).toMatchObject({ prices: { small: { input: 1, output: 2 }, large: { input: 3, output: 4 } } })
  })

  test("arrays, strings and class instances replace their defaults", () => {
    expect(merge({ roots: ["c"], title: "u", ownership: { renew: "none" } })).toEqual({
      ...defaults, roots: ["c"], title: "u", ownership: { mode: "lease", ttlMs: 60_000, renew: "none" },
    })
    const key = Redacted.make("sk")
    expect(merge({ secret: { key, label: "x" } })).toMatchObject({ secret: { key, label: "x" } })
    expect(mergeOptions(Config, { ...defaults, secret: { key: Redacted.make("old"), label: "y" } }, { secret: { key } })).toMatchObject({ secret: { key, label: "y" } })
  })

  test("an object of another of the shapes a union allows replaces its default instead of merging into it", () => {
    expect(merge({ ownership: { mode: "process" } })).toEqual({ ...defaults, ownership: { mode: "process" } })
    expect(merge({ ownership: { mode: "process" }, inbox: { attempts: 5 } })).toEqual({ ...defaults, ownership: { mode: "process" }, inbox: { maxPending: 20, attempts: 5 } })
  })

  test("what fits no shape stays merged, so decoding names the key at fault", () => {
    expect(merge({ ownership: { ttlMs: 1, typo: true } })).toEqual({ ...defaults, ownership: { mode: "lease", ttlMs: 1, renew: { everyMs: 20_000 }, typo: true } })
    expect(merge({ extra: 1 })).toEqual({ ...defaults, extra: 1 })
  })

  test("no options are the defaults, and merging the result again changes nothing", () => {
    expect(merge({})).toEqual(defaults)
    const once = merge({ ownership: { mode: "process" }, inbox: { maxPending: 50 } })
    expect(mergeOptions(Config, defaults, once)).toEqual(once)
  })
})

describe("provideDeclared", () => {
  const Prefix = Context.Reference<string>("test/Prefix", { defaultValue: () => "ws" })
  const workspace = SessionEnvironment.pipe(Effect.map((environment) => environment.workspace))

  test("runs the work where it is called, with that place's services, once every required key is there; a Reference needs none", async () => {
    const declared = provideDeclared("test/owner", [SessionEnvironment, Prefix])(Effect.all([Prefix, workspace], { concurrency: 1 }))
    const at = (name: string) => Effect.runPromise(Effect.provide(declared, Context.make(SessionEnvironment, { workspace: name })))
    expect([await at("a"), await at("b")]).toEqual([["ws", "a"], ["ws", "b"]])
  })

  test("fails with requires.missing, naming the owner and each missing key, before the work starts", async () => {
    const started = await Effect.runPromise(Ref.make(false))
    const declared = provideDeclared("test/owner", [ActionPolicy, Prefix, SessionEnvironment])(Ref.set(started, true))
    const error = await Effect.runPromise(Effect.flip(declared))
    expect([error.code, error.message]).toEqual(["requires.missing", `test/owner requires ${ActionPolicy.key}, ${SessionEnvironment.key}`])
    expect(await Effect.runPromise(Ref.get(started))).toBe(false)
  })

  test("the work may need only the services it declares", () => {
    // @ts-expect-error -- the work reads SessionEnvironment, which is not declared.
    const undeclared = provideDeclared("test/owner", [ActionPolicy])(workspace)
    const declared = provideDeclared("test/owner", [ActionPolicy, SessionEnvironment])(workspace)
    expect([Effect.isEffect(undeclared), Effect.isEffect(declared)]).toEqual([true, true])
  })
})
