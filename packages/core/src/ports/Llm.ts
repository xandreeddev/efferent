import { Context, Data, type Effect, type Stream } from "effect"
import type { AgentTool } from "../domain/AgentTool.js"
import type { Classification } from "../domain/Classification.js"
import type {
  AgentResult,
  ConversationMessage,
} from "../domain/Conversation.js"

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export interface LlmImage {
  readonly bytes: Uint8Array
  readonly mimeType: string
}

export interface LlmGenerateInput {
  readonly prompt: string
  readonly images?: ReadonlyArray<LlmImage>
  readonly system?: string
}

export interface LlmRunAgentInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
  readonly maxSteps?: number
}

export class Llm extends Context.Tag("@agent/core/Llm")<
  Llm,
  {
    readonly classify: (
      message: string,
    ) => Effect.Effect<Classification, LlmError>
    readonly generate: (
      input: LlmGenerateInput,
    ) => Effect.Effect<string, LlmError>
    readonly streamGenerate: (
      input: LlmGenerateInput,
    ) => Stream.Stream<string, LlmError>
    readonly runAgent: <R>(
      input: LlmRunAgentInput<R>,
    ) => Effect.Effect<AgentResult, LlmError, R>
  }
>() {}
