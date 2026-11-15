import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { makeBrowserModel } from "./make.ts"
import { loadEcho } from "./mock.ts"
import { streamDelta, streamEnd, streamFinish, streamStart } from "../prompt-map.ts"

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)

/** The parts one answer of `model` streams, each as its type, a name part with the name it gives. */
const partsOf = (model: LanguageModel.LanguageModel, offered: boolean) =>
  Effect.runPromise(Stream.runCollect((offered
    ? model.streamText({ prompt: Prompt.make("What is 2 + 3?"), toolkit: tools, disableToolCallResolution: true })
    : model.streamText({ prompt: Prompt.make("Hi.") })).pipe(
    Stream.map((part) => (part.type === "response-metadata" ? `named ${part.modelId}` : part.type)),
  )).pipe(Effect.provide(tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })))).then((parts) => Array.from(parts))

describe("a page model names itself", () => {
  test("each answer starts with the model's name, once, before its text: Echo, and Echo loaded under another name", async () => {
    expect((await partsOf(loadEcho().model, false)).slice(0, 2)).toEqual(["named echo", "text-start"])
    const spare = await partsOf(loadEcho(undefined, "echo-spare").model, false)
    expect(spare.filter((part) => part.startsWith("named"))).toEqual(["named echo-spare"])
    expect(spare[0]).toBe("named echo-spare")
  })

  test("a model given tools by the text protocol names itself once, before the text and the call it wrote", async () => {
    const written = makeBrowserModel("written", {
      generateText: () => Effect.die("this model streams"),
      streamText: () => Stream.fromIterable([streamStart, streamDelta('Sure. <tool_call>{"name":"add","arguments":{"a":2,"b":3}}</tool_call>'), streamEnd, streamFinish({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })]) as never,
    })
    expect(await partsOf(written, true)).toEqual(["named written", "text-start", "text-delta", "text-end", "tool-call", "finish"])
  })
})
