import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  tool,
} from "ai"
import { Effect, JSONSchema, Runtime, Schema, Stream } from "effect"
import {
  type AgentHooks,
  type AgentMessage,
  type AgentTool,
  Llm,
  type LlmCacheHint,
  LlmError,
  type LlmGenerateInput,
  type LlmRunTurnInput,
  type LlmRunTurnResult,
  type LlmSnapshotInput,
  type ToolCall,
} from "@agent/core"

/**
 * Vercel AI SDK adapter for the `Llm` port. Provider-agnostic over any
 * `LanguageModel` the SDK accepts — Google, OpenAI, Anthropic, etc.
 *
 * The agent loop lives in `@agent/application/_loop/agentLoop.ts` and
 * drives one turn at a time through `Llm.runTurn`. Each call sends the
 * full message buffer (`[...messages]`); the SDK executes tool calls in
 * its `execute` callback (where we wire `onBeforeToolCall` /
 * `onAfterToolCall` and gracefully catch `AgentToolError`). We return
 * just the new messages this turn produced; the loop appends them to
 * its running buffer.
 *
 * `AgentMessage` is structurally a mirror of v6 `ModelMessage`, so
 * crossing the boundary is a near-identity cast in both directions.
 */

/**
 * Local mirror of the SDK's `ProviderOptions` shape — not in the `ai`
 * package's public exports, but structurally just a nested map of JSON
 * values per provider.
 */
type LocalProviderOptions = Readonly<
  Record<string, Readonly<Record<string, string | number | boolean | null>>>
>

/**
 * Cache strategy plugged in by the provider (gemini.ts). Handles:
 *
 *  - `staticOptionsFor`: returns providerOptions for the static
 *    (system + tools) cache when no per-conversation hint is set.
 *    Lazy-creates the cache on first call.
 *  - `interpretHint`: decodes the opaque `cacheHint` into
 *    `{ cachedContent, skipMessages }` — the cache resource name and
 *    how many messages of `input.messages` are already in it.
 *  - `snapshot`: creates a new cache covering the full
 *    `(system + tools + messages)` prefix and returns an opaque hint.
 */
export interface CacheStrategy {
  readonly staticOptionsFor?: <R>(
    input: LlmRunTurnInput<R>,
  ) => Effect.Effect<LocalProviderOptions | undefined, never>
  readonly interpretHint?: (
    hint: LlmCacheHint,
  ) => { readonly cachedContent: string; readonly skipMessages: number } | undefined
  readonly snapshot?: <R>(
    input: LlmSnapshotInput<R>,
  ) => Effect.Effect<LlmCacheHint | undefined, never>
}

export interface BuildLlmOptions {
  readonly cacheStrategy?: CacheStrategy
}

/**
 * Adapter-side extraction: per-turn `assistantText` and `toolCalls` are
 * computed here from the new messages before crossing back into the
 * application layer. The use case stays out of the content-part shape.
 */
const messageText = (m: AgentMessage): string => {
  if (m.role !== "assistant") return ""
  return m.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

const messageToolCalls = (m: AgentMessage): ReadonlyArray<ToolCall> => {
  if (m.role !== "assistant") return []
  return m.content
    .filter(
      (p): p is { type: "tool-call"; toolName: string; input: unknown; toolCallId: string } =>
        p.type === "tool-call",
    )
    .map((p) => ({ toolName: p.toolName, args: p.input }))
}

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

const toToolInputSchema = <I>(schema: Schema.Schema<I, any>) =>
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

const buildSdkTools = <R>(
  tools: ReadonlyArray<AgentTool<any, any, R>>,
  hooks: AgentHooks<R> | undefined,
  turnIndex: number,
  runtime: Runtime.Runtime<R>,
) =>
  Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: toToolInputSchema(t.parameters),
        execute: async (rawArgs: unknown) => {
          if (hooks?.onBeforeToolCall) {
            const decision = await Runtime.runPromise(runtime)(
              hooks.onBeforeToolCall({
                turnIndex,
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
                    turnIndex,
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
          // Catch AgentToolError → structured failure so the SDK
          // doesn't promote it to a tool-execution error (which would
          // abort the whole generateText call).
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
                turnIndex,
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

export const buildLlm = (
  model: LanguageModel,
  options: BuildLlmOptions = {},
) =>
  Llm.of({
    generate: (input) =>
      Effect.tryPromise({
        try: () =>
          generateText({
            model,
            ...(input.system !== undefined ? { system: input.system } : {}),
            messages: [buildUserMessage(input)],
          }),
        catch: (cause) =>
          new LlmError({ cause, message: "LLM generate failed" }),
      }).pipe(Effect.map((res) => res.text)),

    streamGenerate: (input: LlmGenerateInput) =>
      Stream.fromAsyncIterable(
        (async function* () {
          const result = streamText({
            model,
            ...(input.system !== undefined ? { system: input.system } : {}),
            messages: [buildUserMessage(input)],
          })
          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              yield part.text
            } else if (part.type === "error") {
              throw part.error
            }
          }
        })(),
        (cause) =>
          new LlmError({ cause, message: "LLM stream failed" }),
      ),

    runTurn: <R>(
      input: LlmRunTurnInput<R>,
    ): Effect.Effect<LlmRunTurnResult, LlmError, R> =>
      Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>()
        const sdkTools = buildSdkTools(
          input.tools,
          input.hooks,
          input.turnIndex,
          runtime,
        )

        const cache = options.cacheStrategy

        // Resolve which cache to use this turn:
        //   1. If caller passed a `cacheHint` (per-conversation cache)
        //      and the provider can decode it, use that — sending only
        //      the messages beyond what's already in the cache.
        //   2. Otherwise fall back to the static (system + tools)
        //      cache via `staticOptionsFor`.
        let providerOptions: LocalProviderOptions | undefined
        let skipMessages = 0

        if (input.cacheHint !== undefined && cache?.interpretHint) {
          const decoded = cache.interpretHint(input.cacheHint)
          if (decoded !== undefined) {
            providerOptions = {
              google: { cachedContent: decoded.cachedContent },
            }
            skipMessages = decoded.skipMessages
          }
        }
        if (providerOptions === undefined && cache?.staticOptionsFor) {
          providerOptions = yield* cache.staticOptionsFor(input)
        }

        const requestMessages =
          skipMessages > 0
            ? (input.messages.slice(
                skipMessages,
              ) as ReadonlyArray<ModelMessage> as ModelMessage[])
            : (input.messages as ReadonlyArray<ModelMessage> as ModelMessage[])

        const step = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model,
              system: input.system,
              messages: requestMessages,
              tools: sdkTools,
              stopWhen: stepCountIs(1),
              ...(providerOptions !== undefined
                ? { providerOptions: providerOptions as never }
                : {}),
            }),
          catch: (cause) =>
            new LlmError({
              cause,
              message: `LLM turn ${input.turnIndex} failed`,
            }),
        })

        // Surface token usage + cache-read ratio per turn.
        const u = step.usage
        const inDet = u.inputTokenDetails
        const outDet = u.outputTokenDetails
        yield* Effect.log(
          `[llm.turn=${input.turnIndex}] ` +
            `in=${u.inputTokens ?? "?"} (cache=${
              inDet.cacheReadTokens ?? 0
            } fresh=${inDet.noCacheTokens ?? 0}) ` +
            `out=${u.outputTokens ?? "?"} (text=${
              outDet.textTokens ?? 0
            } think=${outDet.reasoningTokens ?? 0}) ` +
            `finish=${step.finishReason}`,
        )

        // Cast back: SDK's ResponseMessage is structurally identical to
        // our AgentMessage union (assistant + tool variants with content
        // parts that match our TextPart/ReasoningPart/ToolCallPart/
        // ToolResultPart shapes including `providerOptions` for
        // round-tripping fields like Gemini's thought_signature).
        const newMessages = step.response.messages as unknown as ReadonlyArray<AgentMessage>
        const assistantText = newMessages.map(messageText).join("")
        const toolCalls = newMessages.flatMap(messageToolCalls)

        return {
          newMessages,
          finishReason: step.finishReason,
          assistantText,
          toolCalls,
        }
      }),

    snapshot: <R>(
      input: LlmSnapshotInput<R>,
    ): Effect.Effect<LlmCacheHint | undefined, never, R> => {
      if (options.cacheStrategy?.snapshot === undefined) {
        return Effect.succeed(undefined)
      }
      return options.cacheStrategy.snapshot(input) as Effect.Effect<
        LlmCacheHint | undefined,
        never,
        R
      >
    },
  })
