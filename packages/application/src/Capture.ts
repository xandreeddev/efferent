import { Effect } from "effect"
import { Llm, type LlmImage } from "@agent/core"
import { capturePrompt } from "./_prompts/capture.js"

export interface CaptureInput {
  readonly text?: string
  readonly image?: LlmImage
}

export const capture = (input: CaptureInput) =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const userText =
      input.text !== undefined && input.text.length > 0
        ? input.text
        : "[no text provided — see attached image]"
    return yield* llm.generate({
      system: capturePrompt,
      prompt: userText,
      ...(input.image !== undefined ? { images: [input.image] } : {}),
    })
  })
