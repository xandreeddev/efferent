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
  type AgentHooks,
  type AgentResult,
  type AgentTool,
  Classification,
  Llm,
  LlmError,
  type LlmGenerateInput,
  type ConversationMessage,
  type ToolCall,
  type ToolResult,
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
 * Tool messages from prior chat turns are dropped — our domain doesn't
 * track toolCallIds across runAgent invocations. Within ONE invocation,
 * proper tool/assistant threading is maintained via the SDK's own
 * `response.messages` (a CoreMessage[] with real toolCallIds) which we
 * append to the working buffer between loop iterations.
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

type GracefulToolError = {
  readonly ok: false
  readonly tool: string
  readonly error: string
  readonly message: string
}
type BlockedToolResult = {
  readonly ok: false
  readonly blocked: true
  readonly reason: string
}

const isToolFailure = (
  v: unknown,
): v is GracefulToolError | BlockedToolResult =>
  typeof v === "object" &&
  v !== null &&
  "ok" in v &&
  (v as { ok: unknown }).ok === false

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

      /**
       * Hand-rolled agent loop. Drives the SDK one step at a time with
       * `maxSteps: 1`, so we own the iteration and can emit hooks between
       * rounds. Tool execution still happens inside the SDK's `execute`
       * callback — we wrap it to consult `onBeforeToolCall`/`onAfterToolCall`
       * and to map AgentToolError into a structured result so a single
       * tool failure doesn't abort the whole turn.
       */
      runAgent: <R>(input: {
        readonly system: string
        readonly messages: ReadonlyArray<ConversationMessage>
        readonly tools: ReadonlyArray<AgentTool<any, any, R>>
        readonly maxSteps?: number
        readonly hooks?: AgentHooks<R>
      }) =>
        Effect.gen(function* () {
          const runtime = yield* Effect.runtime<R>()
          const hooks = input.hooks
          const maxSteps = input.maxSteps ?? 5

          const sdkTools = Object.fromEntries(
            input.tools.map((t) => [
              t.name,
              tool({
                description: t.description,
                parameters: toToolParameters(t.parameters),
                execute: async (rawArgs: unknown) => {
                  // Hook: onBeforeToolCall can block the call.
                  if (hooks?.onBeforeToolCall) {
                    const decision = await Runtime.runPromise(runtime)(
                      hooks.onBeforeToolCall({
                        turnIndex: -1, // not tracked at SDK callback level
                        toolName: t.name,
                        args: rawArgs,
                      }),
                    )
                    if (decision.action === "block") {
                      const blocked: BlockedToolResult = {
                        ok: false,
                        blocked: true,
                        reason: decision.reason,
                      }
                      if (hooks.onAfterToolCall) {
                        await Runtime.runPromise(runtime)(
                          hooks.onAfterToolCall({
                            turnIndex: -1,
                            toolName: t.name,
                            args: rawArgs,
                            ok: false,
                            result: blocked,
                          }),
                        )
                      }
                      return blocked
                    }
                  }
                  // Execute. Catch AgentToolError → structured failure so
                  // the SDK doesn't promote it to AI_ToolExecutionError
                  // (which aborts the whole generateText call).
                  const validated = Schema.decodeUnknownSync(t.parameters)(rawArgs)
                  const result = await Runtime.runPromise(runtime)(
                    t.execute(validated).pipe(
                      Effect.catchTag("AgentToolError", (err) => {
                        const errTag =
                          err.cause !== undefined &&
                          err.cause !== null &&
                          typeof err.cause === "object" &&
                          "_tag" in err.cause
                            ? String((err.cause as { _tag: unknown })._tag)
                            : "AgentToolError"
                        const errMsg =
                          err.cause instanceof Error
                            ? err.cause.message
                            : String(err.cause)
                        const failure: GracefulToolError = {
                          ok: false,
                          tool: err.tool,
                          error: errTag,
                          message: errMsg,
                        }
                        return Effect.succeed(failure)
                      }),
                    ),
                  )
                  if (hooks?.onAfterToolCall) {
                    await Runtime.runPromise(runtime)(
                      hooks.onAfterToolCall({
                        turnIndex: -1,
                        toolName: t.name,
                        args: rawArgs,
                        ok: !isToolFailure(result),
                        result,
                      }),
                    )
                  }
                  return result
                },
              }),
            ]),
          )

          // Working state, mutated each turn.
          let workingMessages = input.messages
          let coreMessages: CoreMessage[] = toCoreMessages(workingMessages)
          const collectedToolCalls: ToolCall[] = []
          const collectedToolResults: ToolResult[] = []
          let finalText = ""

          for (let turnIndex = 0; turnIndex < maxSteps; turnIndex++) {
            if (hooks?.onTransformContext) {
              const transformed = yield* hooks.onTransformContext(workingMessages)
              if (transformed !== workingMessages) {
                workingMessages = transformed
                coreMessages = toCoreMessages(workingMessages)
              }
            }
            if (hooks?.onTurnStart) {
              yield* hooks.onTurnStart({ turnIndex, messages: workingMessages })
            }

            const step = yield* Effect.tryPromise({
              try: () =>
                generateText({
                  model,
                  system: input.system,
                  messages: coreMessages,
                  tools: sdkTools,
                  maxSteps: 1,
                }),
              catch: (cause) =>
                new LlmError({
                  cause,
                  message: `Gemini turn ${turnIndex} failed`,
                }),
            })

            const turnCalls: ToolCall[] = step.toolCalls.map((tc) => ({
              toolName: tc.toolName,
              args: tc.args,
            }))
            const turnResults: ToolResult[] = step.toolResults.map((tr) => ({
              toolName: tr.toolName,
              result: tr.result,
            }))
            collectedToolCalls.push(...turnCalls)
            collectedToolResults.push(...turnResults)
            if (step.text && step.text.length > 0) {
              finalText = step.text
            }

            if (hooks?.onAssistantMessage) {
              yield* hooks.onAssistantMessage({
                turnIndex,
                text: step.text ?? "",
                toolCalls: turnCalls,
              })
            }

            // Thread this round's assistant + tool messages back into the
            // SDK's view for the next iteration.
            coreMessages = [...coreMessages, ...step.response.messages]

            // Loop exit when the model stops calling tools.
            if (step.finishReason !== "tool-calls" || turnCalls.length === 0) {
              break
            }

            if (hooks?.onShouldStopAfterTurn) {
              const stop = yield* hooks.onShouldStopAfterTurn({
                turnIndex,
                finishReason: step.finishReason,
              })
              if (stop) break
            }
          }

          if (hooks?.onAgentEnd) {
            yield* hooks.onAgentEnd({
              messages: workingMessages,
              finalText,
            })
          }

          const agentResult: AgentResult = {
            finalText,
            toolCalls: collectedToolCalls,
            toolResults: collectedToolResults,
          }
          return agentResult
        }),
    })
  }),
)
