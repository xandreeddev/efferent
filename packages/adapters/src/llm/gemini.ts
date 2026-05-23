import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateObject, generateText, streamText } from "ai"
import { Config, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { z } from "zod"
import {
  Classification,
  Llm,
  LlmError,
  type LlmGenerateInput,
} from "@agent/core"

const buildUserMessage = (input: LlmGenerateInput) =>
  ({
    role: "user" as const,
    content: [
      { type: "text" as const, text: input.prompt },
      ...(input.images ?? []).map((img) => ({
        type: "image" as const,
        image: img.bytes,
        mimeType: img.mimeType,
      })),
    ],
  })

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

      generate: (input) =>
        Effect.tryPromise({
          try: () =>
            generateText({
              model,
              ...(input.system !== undefined ? { system: input.system } : {}),
              messages: [buildUserMessage(input)],
            }),
          catch: (cause) =>
            new LlmError({ cause, message: "Gemini generate failed" }),
        }).pipe(Effect.map((res) => res.text)),

      streamGenerate: (input: LlmGenerateInput) =>
        Stream.fromAsyncIterable(
          (async function* () {
            const result = streamText({
              model,
              ...(input.system !== undefined ? { system: input.system } : {}),
              messages: [buildUserMessage(input)],
            })
            // Consume fullStream so error parts surface as thrown errors
            // (textStream silently ends on errors in AI SDK v4).
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                yield part.textDelta
              } else if (part.type === "error") {
                throw part.error
              }
            }
          })(),
          (cause) =>
            new LlmError({ cause, message: "Gemini stream failed" }),
        ),
    })
  }),
)
