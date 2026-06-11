import { describe, expect, it } from "bun:test"
import { Prompt } from "@effect/ai"
import { withAnthropicCacheBreakpoints } from "./providers.js"

const promptOf = (result: unknown): ReadonlyArray<Prompt.Message> =>
  (result as { prompt: Prompt.Prompt }).prompt.content

const cacheControlOf = (msg: Prompt.Message): unknown =>
  (msg.options["anthropic"] as Record<string, unknown> | undefined)?.["cacheControl"]

describe("withAnthropicCacheBreakpoints", () => {
  it("stamps the last system message and the last two non-system messages", () => {
    const options = {
      prompt: Prompt.make([
        { role: "system", content: "be helpful" },
        { role: "user", content: "read the file" },
        { role: "assistant", content: "reading" },
        { role: "user", content: "now edit it" },
      ]),
      toolkit: "untouched",
    }
    const result = withAnthropicCacheBreakpoints(options)
    const msgs = promptOf(result)
    expect(cacheControlOf(msgs[0]!)).toEqual({ type: "ephemeral" }) // system
    expect(cacheControlOf(msgs[1]!)).toBeUndefined() // old turn — never touched
    expect(cacheControlOf(msgs[2]!)).toEqual({ type: "ephemeral" }) // tail -2
    expect(cacheControlOf(msgs[3]!)).toEqual({ type: "ephemeral" }) // tail -1
    expect((result as { toolkit: string }).toolkit).toBe("untouched") // envelope preserved
  })

  it("merges into existing anthropic options instead of replacing them", () => {
    const options = {
      prompt: Prompt.make([
        { role: "system", content: "s" },
        {
          role: "user",
          content: "u",
          options: { anthropic: { keep: "me" } as Record<string, unknown> },
        },
      ]),
    }
    const msgs = promptOf(withAnthropicCacheBreakpoints(options))
    expect(msgs[1]!.options["anthropic"] as Record<string, unknown>).toEqual({
      keep: "me",
      cacheControl: { type: "ephemeral" },
    })
  })

  it("an explicit cacheControl already on a message wins", () => {
    const options = {
      prompt: Prompt.make([
        {
          role: "user",
          content: "u",
          options: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        },
      ]),
    }
    const msgs = promptOf(withAnthropicCacheBreakpoints(options))
    expect(cacheControlOf(msgs[0]!)).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("an empty prompt passes through; a single message still gets stamped", () => {
    const empty = { prompt: Prompt.empty }
    expect(withAnthropicCacheBreakpoints(empty)).toBe(empty)

    const single = { prompt: Prompt.make([{ role: "user", content: "hi" }]) }
    const msgs = promptOf(withAnthropicCacheBreakpoints(single))
    expect(cacheControlOf(msgs[0]!)).toEqual({ type: "ephemeral" })
  })

  it("with many trailing messages, exactly system + two tail markers exist (≤4 budget)", () => {
    const options = {
      prompt: Prompt.make([
        { role: "system", content: "s" },
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
        { role: "assistant", content: "4" },
        { role: "user", content: "5" },
      ]),
    }
    const msgs = promptOf(withAnthropicCacheBreakpoints(options))
    const stamped = msgs.filter((m) => cacheControlOf(m) !== undefined)
    expect(stamped.length).toBe(3)
  })
})
