import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateObject } from "ai"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { z } from "zod"
import { Classification, Llm, LlmError } from "@agent/core"

const ZClassification = z.object({
  intent: z.enum([
    "add_todo",
    "list_todos",
    "complete_todo",
    "ask",
    "other",
  ]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

export const LlmLive = Layer.effect(
  Llm,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_GENERATIVE_AI_API_KEY")
    const modelName = yield* Config.string("AGENT_MODEL").pipe(
      Config.withDefault("gemini-3.5-flash"),
    )
    const provider = createGoogleGenerativeAI({
      apiKey: Redacted.value(apiKey),
    })
    const model = provider(modelName)

    return Llm.of({
      classify: (message: string) =>
        Effect.tryPromise({
          try: () =>
            generateObject({
              model,
              schema: ZClassification,
              prompt:
                `Classify the user message into exactly one intent from the schema.\n` +
                `Return your best guess with a confidence in [0,1] and a one-sentence reasoning.\n` +
                `Message: ${JSON.stringify(message)}`,
            }),
          catch: (cause) =>
            new LlmError({ cause, message: "Gemini classification failed" }),
        }).pipe(
          Effect.flatMap((res) =>
            Schema.decodeUnknown(Classification)(res.object).pipe(
              Effect.mapError(
                (cause) =>
                  new LlmError({
                    cause,
                    message:
                      "LLM returned a value that violates the Classification schema",
                  }),
              ),
            ),
          ),
        ),
    })
  }),
)
