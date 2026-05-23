import { Context, Data, type Effect } from "effect"
import type { Classification } from "../domain/Classification.js"

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

export class Llm extends Context.Tag("@agent/core/Llm")<
  Llm,
  {
    readonly classify: (
      message: string,
    ) => Effect.Effect<Classification, LlmError>
    readonly generate: (
      input: LlmGenerateInput,
    ) => Effect.Effect<string, LlmError>
  }
>() {}
