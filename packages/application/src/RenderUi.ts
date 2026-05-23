import { Effect, Stream } from "effect"
import { CaptureStore, Llm } from "@agent/core"
import { renderUiPrompt } from "./_prompts/render-ui.js"

const buildContext = (
  captures: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly body: string
    readonly createdAt: Date
  }>,
): string =>
  JSON.stringify(
    captures.slice(0, 50).map((c) => ({
      id: c.id,
      title: c.title,
      body_excerpt: c.body.length > 400 ? `${c.body.slice(0, 400)}...` : c.body,
      created_at: c.createdAt.toISOString(),
    })),
    null,
    2,
  )

/**
 * UI agent: takes the user's request, pre-fetches all captures, asks the
 * LLM for a single HTML fragment, streams chunks back.
 */
export const renderUi = (userPrompt: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* CaptureStore
      const llm = yield* Llm
      const captures = yield* store.list()
      const context = buildContext(captures)
      const prompt =
        `User request: ${userPrompt.trim()}\n\n` +
        `Available captures (JSON):\n${context}`
      return llm.streamGenerate({
        system: renderUiPrompt,
        prompt,
      })
    }),
  )
