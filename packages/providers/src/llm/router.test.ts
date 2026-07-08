import { describe, expect, test } from "bun:test"
import { LanguageModel } from "@effect/ai"
import { stampResponse } from "./router.js"

const finish = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
}

const content = [
  { type: "text", text: "listing…" },
  { type: "tool-call", id: "c1", name: "ls", params: { path: "." } },
  finish,
]

describe("stampResponse", () => {
  test("stamps the resolved model onto the finish part's metadata", () => {
    const stamped = stampResponse({ content }, "opencode:kimi-k2.6")
    const finishPart = stamped.content.find(
      (p) => (p as { type?: string }).type === "finish",
    ) as { metadata?: { router?: { model?: string } } }
    expect(finishPart.metadata?.router?.model).toBe("opencode:kimi-k2.6")
  })

  test("REGRESSION: the class getters survive — a plain spread killed the loop", () => {
    // finishReason/text/usage are prototype getters on GenerateTextResponse;
    // `{...res}` strips them, finishReason reads undefined, and the engine
    // loop sees every tool-calling turn as "completed" (one tool call, then
    // the run silently dies). stampResponse must return a REAL instance.
    const stamped = stampResponse(
      new LanguageModel.GenerateTextResponse(content as never),
      "opencode:kimi-k2.6",
    )
    expect(stamped).toBeInstanceOf(LanguageModel.GenerateTextResponse)
    expect(stamped.finishReason).toBe("tool-calls")
    expect(stamped.text).toBe("listing…")
    expect(stamped.usage.totalTokens).toBe(15)
  })
})
