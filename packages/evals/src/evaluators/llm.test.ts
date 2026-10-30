import { expect, test } from "bun:test"
import { LanguageModel, Prompt } from "effect/ai"
import { Effect, Layer, Schema, Stream } from "effect"
import { llmEvaluator } from "./llm.js"

test("an LLM evaluator asks for its object under its id, each character but letters, digits and _ an underscore", async () => {
  const formats: Array<unknown> = []
  const model = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: (request) => Effect.sync(() => formats.push(request.responseFormat.type === "json" ? request.responseFormat.objectName : request.responseFormat.type))
      .pipe(Effect.as([
        { type: "text" as const, text: JSON.stringify({ quality: 0.8 }) },
        { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
      ])),
    streamText: () => Stream.die("unused"),
  }))
  const evaluator = llmEvaluator({
    id: "answer-quality.v2", version: "1", metrics: ["quality"],
    prompt: (answer: string) => Prompt.make([{ role: "user", content: answer }]),
    schema: Schema.Struct({ quality: Schema.Number }),
    assessment: ({ quality }) => ({ metrics: [{ kind: "probability", name: "quality", value: quality }], reason: "scripted" }),
  })
  const assessment = await Effect.runPromise(evaluator.run("Open at 09:00.").pipe(Effect.provide(model)))
  expect(formats).toEqual(["answer_quality_v2"])
  expect(assessment.metrics).toEqual([{ kind: "probability", name: "quality", value: 0.8 }])
})
