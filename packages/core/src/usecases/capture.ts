import { Effect } from "effect"
import type { LlmImage } from "../ports/Llm.js"
import { LlmFast } from "../ports/LlmFast.js"
import { capturePrompt } from "../prompts/capture.js"
import { extractTitle } from "./extractTitle.js"

export interface CaptureInput {
  readonly text?: string
  readonly image?: LlmImage
}

export interface CaptureResult {
  readonly title: string
  readonly body: string
}

export const capture = (input: CaptureInput) =>
  Effect.gen(function* () {
    const llm = yield* LlmFast
    const userText =
      input.text !== undefined && input.text.length > 0
        ? input.text
        : "[no text provided — see attached image]"
    const body = yield* llm.generate({
      system: capturePrompt,
      prompt: userText,
      ...(input.image !== undefined ? { images: [input.image] } : {}),
    })
    return { title: extractTitle(body), body } satisfies CaptureResult
  })
