import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { definePlugin } from "./plugin.adapter.js"
import { ActionPolicy, SessionEnvironment } from "../ports/harness.port.js"
import { HarnessError } from "./plugin.entity.js"

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

  test("live refuses keys the config does not declare, with config.options", async () => {
    const extra = { excited: true, loud: true } as Partial<typeof namer.config.Encoded>
    expect(await workspaceOf(namer.live(extra).pipe(Layer.provide(approval)))).toMatchObject({
      _tag: "Failure", failure: { _tag: "HarnessError", code: "config.options", plugin: "test/namer" },
    })
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
    expect([error instanceof HarnessError, error.code, error.message, error.plugin]).toEqual([true, "skills.duplicate", "two skills x", "test/other-copy"])
  })
})
