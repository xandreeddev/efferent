import { expect, test } from "bun:test"
import { Effect, Schema, SchemaGetter, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { prepareToolkit } from "./prepared-toolkit.adapter.js"

test("preparation decodes once on an isolated copy and starts no handlers", async () => {
  let decodes = 0
  const handled: unknown[] = []
  const input = { value: "provider" }
  const tool = Tool.make("once", {
    parameters: Schema.Struct({ value: Schema.String }).pipe(Schema.decodeTo(Schema.Struct({ value: Schema.String }), {
      decode: SchemaGetter.transformEffect((value) => Effect.sync(() => { decodes++; Reflect.set(value, "value", `${value.value}:decoded`); return value })),
      encode: SchemaGetter.transform((value) => value),
    })),
    success: Schema.String,
  })
  const toolkit = prepareToolkit(Toolkit.make(tool))
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const execution = yield* toolkit.execution
    const first = yield* execution.prepare("once", input)
    const second = yield* execution.prepare("once", { value: "second" })
    expect(handled).toEqual([])
    expect(first.input).toEqual({ value: "provider" })
    expect(input).toEqual({ value: "provider" })
    const result = yield* first.run("c1").pipe(Effect.flatMap(Stream.runCollect))
    yield* second.run("c2").pipe(Effect.flatMap(Stream.runDrain))
    return result
  }).pipe(Effect.provide(toolkit.toLayer({ once: (value) => Effect.sync(() => { handled.push(value); return value.value }) }))))
  expect(decodes).toBe(2)
  expect(handled).toEqual([{ value: "provider:decoded" }, { value: "second:decoded" }])
  expect(observed[0]?.encodedResult).toBe("provider:decoded")
  expect(toolkit.tools.once.parametersSchema).toBe(tool.parametersSchema)
})
