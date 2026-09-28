import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { definePlugin } from "./plugin.adapter.js"
import { Approval, SessionEnvironment } from "../ports/harness.port.js"

/** Provides a workspace named from its options and what the Approval it requires answers. */
const namer = definePlugin({
  id: "test/namer", version: "1", scope: "runtime",
  config: Schema.Struct({ prefix: Schema.String, excited: Schema.Boolean }),
  defaults: { prefix: "ws", excited: false },
  requires: [Approval],
  provides: [SessionEnvironment],
  layer: ({ prefix, excited }) => Layer.effect(SessionEnvironment, Approval.pipe(
    Effect.flatMap((approval) => approval.request("name the workspace")),
    Effect.map((approved) => ({ workspace: `${prefix}:${approved}${excited ? "!" : ""}` })),
  )),
})

const approval = Layer.succeed(Approval, { request: () => Effect.succeed(true) })
const workspaceOf = (layer: Layer.Layer<SessionEnvironment, unknown>) =>
  Effect.runPromise(Effect.either(SessionEnvironment.pipe(Effect.map((environment) => environment.workspace), Effect.provide(layer))))

describe("definePlugin", () => {
  test("live is the plugin's typed layer: options merge over the defaults", async () => {
    expect(await workspaceOf(namer.live().pipe(Layer.provide(approval)))).toMatchObject({ _tag: "Right", right: "ws:true" })
    expect(await workspaceOf(namer.live({ excited: true }).pipe(Layer.provide(approval)))).toMatchObject({ _tag: "Right", right: "ws:true!" })
  })

  test("live refuses keys the config does not declare, with config.options", async () => {
    const extra = { excited: true, loud: true } as Partial<typeof namer.config.Encoded>
    expect(await workspaceOf(namer.live(extra).pipe(Layer.provide(approval)))).toMatchObject({
      _tag: "Left", left: { _tag: "HarnessError", code: "config.options", plugin: "test/namer" },
    })
  })

  test("build decodes the same way: missing options default, full options are unchanged", async () => {
    const services = Context.make(Approval, { request: () => Effect.succeed(false) })
    const workspace = (options: unknown) => Effect.runPromise(Effect.scoped(namer.build(options, services)).pipe(
      Effect.map((built) => Context.unsafeGet(built, SessionEnvironment).workspace),
    ))
    expect(await workspace({ excited: true })).toBe("ws:false!")
    expect(await workspace({ ...namer.defaults, prefix: "home" })).toBe("home:false")
    expect(await Effect.runPromise(Effect.either(Effect.scoped(namer.build({ loud: true }, services))))).toMatchObject({
      _tag: "Left", left: { code: "plugin.activation", plugin: "test/namer" },
    })
    expect(namer.schema).toBe(namer.config)
  })
})
