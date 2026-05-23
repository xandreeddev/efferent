import { createGoogleGenerativeAI } from "@ai-sdk/google"
import {
  type CoreMessage,
  generateObject,
  generateText,
  jsonSchema,
  streamText,
  tool,
} from "ai"
import {
  Config,
  Effect,
  JSONSchema,
  Layer,
  Redacted,
  Runtime,
  Schema,
  Stream,
} from "effect"
import { z } from "zod"
import {
  type AgentResult,
  type AgentTool,
  Classification,
  Llm,
  LlmError,
  type LlmGenerateInput,
  type ConversationMessage,
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

/**
 * Map persisted ConversationMessages to the AI SDK's CoreMessage shape.
 * Tool messages are dropped — the assistant's `content` field already
 * summarises what happened, and our domain doesn't yet track toolCallIds
 * (which the SDK requires to thread tool-result messages).
 */
const toCoreMessages = (
  messages: ReadonlyArray<ConversationMessage>,
): CoreMessage[] =>
  messages.flatMap((m): CoreMessage[] => {
    if (m.role === "user") return [{ role: "user", content: m.content }]
    if (m.role === "assistant") {
      return [{ role: "assistant", content: m.content }]
    }
    return []
  })

const toToolParameters = <I>(schema: Schema.Schema<I, any>) =>
  jsonSchema(JSONSchema.make(schema) as any)

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

      runAgent: <R>(input: {
        readonly system: string
        readonly messages: ReadonlyArray<ConversationMessage>
        readonly tools: ReadonlyArray<AgentTool<any, any, R>>
        readonly maxSteps?: number
      }) =>
        Effect.gen(function* () {
          // Capture the caller's runtime so we can run tool Effects (which
          // carry R requirements) from inside the SDK's sync `execute`
          // callbacks. Typed as Runtime<R> via the method's signature.
          const runtime = yield* Effect.runtime<R>()
          const sdkTools = Object.fromEntries(
            input.tools.map((t) => [
              t.name,
              tool({
                description: t.description,
                parameters: toToolParameters(t.parameters),
                execute: async (rawArgs: unknown) => {
                  const validated = Schema.decodeUnknownSync(t.parameters)(
                    rawArgs,
                  )
                  return Runtime.runPromise(runtime)(t.execute(validated))
                },
              }),
            ]),
          )
          const result = yield* Effect.tryPromise({
            try: () =>
              generateText({
                model,
                system: input.system,
                messages: toCoreMessages(input.messages),
                tools: sdkTools,
                maxSteps: input.maxSteps ?? 5,
              }),
            catch: (cause) =>
              new LlmError({ cause, message: "Gemini agent step failed" }),
          })
          // result.toolCalls/result.toolResults only reflect the final step.
          // Walk all steps to surface every tool the agent invoked.
          const allToolCalls = result.steps.flatMap((s) => s.toolCalls)
          const allToolResults = result.steps.flatMap((s) => s.toolResults)
          // Pick the last non-empty text across steps as the assistant's
          // final reply — some models call a tool as their last act and
          // leave result.text empty.
          const finalText =
            result.text && result.text.length > 0
              ? result.text
              : [...result.steps].reverse().find((s) => s.text && s.text.length > 0)?.text ??
                ""
          const agentResult: AgentResult = {
            finalText,
            toolCalls: allToolCalls.map((tc) => ({
              toolName: tc.toolName,
              args: tc.args,
            })),
            toolResults: allToolResults.map((tr) => ({
              toolName: tr.toolName,
              result: tr.result,
            })),
          }
          return agentResult
        }),
    })
  }),
)
