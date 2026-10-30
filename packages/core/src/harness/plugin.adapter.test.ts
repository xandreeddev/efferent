import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { definePlugin } from "./plugin.adapter.js"
import { ActionPolicy, SessionEnvironment } from "../ports/harness.port.js"
import { HarnessError } from "./plugin.entity.js"
import { isHarnessError } from "./plugin.entity.functions.js"

/** Provides a workspace named from its options and whether the ActionPolicy it requires allows naming it. */
const namer = definePlugin({
  id: "test/namer", version: "1", scope: "runtime",
  config: Schema.Struct({ prefix: Schema.String, excited: Schema.Boolean }),
  defaults: { prefix: "ws", excited: false },
  requires: [ActionPolicy],
  provides: [SessionEnvironment],
  layer: ({ prefix, excited }) => Layer.effect(SessionEnvironment, ActionPolicy.pipe(
    Effect.flatMap((policy) => Effect.isSuccess(policy.authorize("name_workspace", {}))),
    Effect.map((allowed) => ({ workspace: `${prefix}:${allowed}${excited ? "!" : ""}` })),
  )),
})

const approval = Layer.succeed(ActionPolicy, { authorize: () => Effect.void })
const workspaceOf = (layer: Layer.Layer<SessionEnvironment, unknown>) =>
  Effect.runPromise(Effect.result(SessionEnvironment.pipe(Effect.map((environment) => environment.workspace), Effect.provide(layer))))

describe("definePlugin", () => {
  test("live is the plugin's typed layer: options merge over the defaults", async () => {
    expect(await workspaceOf(namer.live().pipe(Layer.provide(approval)))).toMatchObject({ _tag: "Success", success: "ws:true" })
    expect(await workspaceOf(namer.live({ excited: true }).pipe(Layer.provide(approval)))).toMatchObject({ _tag: "Success", success: "ws:true!" })
  })

  test("nested options merge over the nested defaults, through live and build alike", async () => {
    const nested = definePlugin({
      id: "test/nested", version: "1", scope: "runtime",
      config: Schema.Struct({
        inbox: Schema.Struct({ maxPending: Schema.Number, attempts: Schema.Number }),
        holder: Schema.Union([Schema.Struct({ mode: Schema.Literal("lease"), ttlMs: Schema.Number }), Schema.Struct({ mode: Schema.Literal("process") })]),
      }),
      defaults: { inbox: { maxPending: 20, attempts: 2 }, holder: { mode: "lease", ttlMs: 60_000 } },
      provides: [SessionEnvironment],
      layer: ({ inbox, holder }) => Layer.succeed(SessionEnvironment, { workspace: `${inbox.maxPending}/${inbox.attempts}/${holder.mode}` }),
    })
    const options = { inbox: { maxPending: 50 }, holder: { mode: "process" } } as const
    expect(await workspaceOf(nested.live(options))).toMatchObject({ _tag: "Success", success: "50/2/process" })
    expect(await workspaceOf(nested.live({ inbox: { attempts: 3 } }))).toMatchObject({ _tag: "Success", success: "20/3/lease" })
    const built = await Effect.runPromise(Effect.scoped(nested.build(options, Context.empty())))
    expect(Context.getUnsafe(built, SessionEnvironment).workspace).toBe("50/2/process")
    const typo = { inbox: { maxPending: 50, typo: 1 } } as Parameters<typeof nested.live>[0]
    expect(await workspaceOf(nested.live(typo))).toMatchObject({
      _tag: "Failure", failure: { code: "config.options", plugin: "test/nested" },
    })
  })

  test("live refuses keys the config does not declare, with config.options", async () => {
    const extra = { excited: true, loud: true } as Partial<typeof namer.config.Encoded>
    expect(await workspaceOf(namer.live(extra).pipe(Layer.provide(approval)))).toMatchObject({
      _tag: "Failure", failure: { _tag: "HarnessError", code: "config.options", plugin: "test/namer" },
    })
  })

  test("config.options keeps the schema's failure as its cause, and its message as the message", async () => {
    const extra = { loud: true } as Partial<typeof namer.config.Encoded>
    const refused = await Effect.runPromise(Effect.flip(Layer.build(namer.live(extra).pipe(Layer.provide(approval))).pipe(Effect.scoped)))
    expect(refused.cause).toMatchObject({ _tag: "SchemaError" })
    expect(refused.message).toBe((refused.cause as Error).message)
    expect(refused.message).toContain("loud")
  })

  test("build decodes the same way: missing options default, full options are unchanged", async () => {
    const services = Context.make(ActionPolicy, { authorize: () => Effect.fail(new HarnessError({ code: "policy.denied", message: "no" })) })
    const workspace = (options: unknown) => Effect.runPromise(Effect.scoped(namer.build(options, services)).pipe(
      Effect.map((built) => Context.getUnsafe(built, SessionEnvironment).workspace),
    ))
    expect(await workspace({ excited: true })).toBe("ws:false!")
    expect(await workspace({ ...namer.defaults, prefix: "home" })).toBe("home:false")
    expect(await Effect.runPromise(Effect.result(Effect.scoped(namer.build({ loud: true }, services))))).toMatchObject({
      _tag: "Failure", failure: { code: "plugin.activation", plugin: "test/namer" },
    })
    expect(namer.schema).toBe(namer.config)
  })

  test("build keeps the code of a HarnessError the layer fails with, and names the plugin", async () => {
    const failing = (error: HarnessError) => definePlugin({
      id: "test/failing", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
      provides: [SessionEnvironment], layer: () => Layer.effect(SessionEnvironment, Effect.fail(error)),
    })
    const built = (error: HarnessError) => Effect.runPromise(Effect.flip(Effect.scoped(failing(error).build({}, Context.empty()))))
    expect(await built(new HarnessError({ code: "skills.duplicate", message: "two skills x" }))).toMatchObject({
      code: "skills.duplicate", message: "two skills x", plugin: "test/failing",
    })
    expect(await built(new HarnessError({ code: "own.code", message: "inner", plugin: "inner/plugin" }))).toMatchObject({ code: "own.code", plugin: "inner/plugin" })
    const underneath = new Error("permission denied")
    expect((await built(new HarnessError({ code: "skills.root", message: "cannot list skills", cause: underneath }))).cause).toBe(underneath)
  })

  test("any other failure is plugin.activation: what failed is its cause, and its message (not its tag or stack) the message's", async () => {
    class NoShell extends Schema.TaggedError<NoShell>()("NoShell", { message: Schema.String }) {}
    const missing = new NoShell({ message: "no executable zsh" })
    missing.stack = "NoShell: no executable zsh\n    at find (/home/user/project/src/shell.ts:3:9)"
    const failing = definePlugin({
      id: "test/shell", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
      provides: [SessionEnvironment], layer: () => Layer.effect(SessionEnvironment, Effect.fail(missing)),
    })
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(failing.build({}, Context.empty()))))
    expect([error.code, error.plugin, error.message]).toEqual(["plugin.activation", "test/shell", "test/shell failed to activate: no executable zsh"])
    expect(error.cause).toBe(missing)
    const undecoded = await Effect.runPromise(Effect.flip(Effect.scoped(namer.build({ loud: true }, Context.empty()))))
    expect([undecoded.code, undecoded.cause]).toMatchObject(["plugin.activation", { _tag: "SchemaError" }])
  })

  test("build keeps the code of a HarnessError the layer dies with; any other defect is plugin.defect", async () => {
    const dying = (defect: unknown) => definePlugin({
      id: "test/dying", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
      provides: [SessionEnvironment], layer: () => Layer.effect(SessionEnvironment, Effect.die(defect)),
    })
    const built = (defect: unknown) => Effect.runPromise(Effect.flip(Effect.scoped(dying(defect).build({}, Context.empty()))))
    expect(await built(new HarnessError({ code: "skills.duplicate", message: "two skills x" }))).toMatchObject({
      code: "skills.duplicate", message: "two skills x", plugin: "test/dying",
    })
    expect(await built(new Error("boom"))).toMatchObject({ code: "plugin.defect", plugin: "test/dying" })
    const boom = new TypeError("x is not a function")
    const defect = await built(boom)
    expect([defect.message, defect.cause]).toEqual(["test/dying died while activating: x is not a function", boom])
    const underneath = new Error("disk full")
    expect((await built(new HarnessError({ code: "skills.files", message: "cannot read a skill", cause: underneath }))).cause).toBe(underneath)
  })

  test("a layer may need only the services `requires` lists: a Reference needs no entry, an optional service is read as an Option", async () => {
    const Prefix = Context.Reference<string>("test/Prefix", { defaultValue: () => "ws" })
    const optional = definePlugin({
      id: "test/optional", version: "1", config: Schema.Struct({}), defaults: {},
      optional: [ActionPolicy], provides: [SessionEnvironment],
      layer: () => Layer.effect(SessionEnvironment, Effect.all([Prefix, Effect.serviceOption(ActionPolicy)], { concurrency: 1 }).pipe(
        Effect.map(([prefix, policy]) => ({ workspace: `${prefix}:${Option.isSome(policy)}` })),
      )),
    })
    const undeclared = definePlugin({
      id: "test/undeclared", version: "1", config: Schema.Struct({}), defaults: {},
      optional: [ActionPolicy], provides: [SessionEnvironment],
      // @ts-expect-error -- the layer needs ActionPolicy, which `requires` does not list (an optional service is read with serviceOption).
      layer: () => Layer.effect(SessionEnvironment, ActionPolicy.pipe(Effect.as({ workspace: "ws" }))),
    })
    expect(await workspaceOf(optional.live())).toMatchObject({ _tag: "Success", success: "ws:false" })
    expect(await workspaceOf(optional.live().pipe(Layer.provide(approval)))).toMatchObject({ _tag: "Success", success: "ws:true" })
    expect([optional.requires, optional.optional, undeclared.requires]).toEqual([[], [ActionPolicy.key], []])
  })

  test("build fails with requires.missing, naming the plugin and each missing key, when a required service is not there", async () => {
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(namer.build({}, Context.empty()))))
    expect([error.code, error.plugin, error.message]).toEqual(["requires.missing", "test/namer", `test/namer requires ${ActionPolicy.key}`])
    expect(await Effect.runPromise(Effect.scoped(namer.build({}, Context.empty())).pipe(
      Effect.provide(approval),
      Effect.map((built) => Context.getUnsafe(built, SessionEnvironment).workspace),
    ))).toBe("ws:true")
  })

  test("build matches a HarnessError by its tag and fields, so one from another copy of core keeps its code too", async () => {
    // What a plugin built against a second copy of @xandreed/core fails with: the same tag, another class.
    class OtherCopyHarnessError extends Schema.TaggedError<OtherCopyHarnessError>()("HarnessError", {
      code: Schema.String, message: Schema.String, plugin: Schema.optional(Schema.String),
    }) {}
    const failing = definePlugin({
      id: "test/other-copy", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
      provides: [SessionEnvironment], layer: () => Layer.effect(SessionEnvironment, Effect.fail(new OtherCopyHarnessError({ code: "skills.duplicate", message: "two skills x" }))),
    })
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(failing.build({}, Context.empty()))))
    expect([isHarnessError(error), error.code, error.message, error.plugin]).toEqual([true, "skills.duplicate", "two skills x", "test/other-copy"])
  })
})
