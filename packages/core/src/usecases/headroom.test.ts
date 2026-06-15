import { describe, expect, it } from "bun:test"
import { Effect, FastCheck as fc, Layer } from "effect"
import { LanguageModel, type Toolkit } from "@effect/ai"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { runAgentLoop } from "./agentLoop.js"
import {
  compressToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  estimateTokens,
  planClip,
  renderClip,
  shouldAutoHandoff,
} from "./headroom.js"

const BIG = "line of log output\n".repeat(3000) // ~57k chars

const toolMsg = (output: unknown): AgentMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "t1", toolName: "Bash", output, isError: false }],
  }) as unknown as AgentMessage

const outputOf = (msg: AgentMessage): Record<string, unknown> =>
  (msg.content as ReadonlyArray<{ output: Record<string, unknown> }>)[0]!.output

describe("planClip / renderClip", () => {
  it("fitting text is left alone; oversized text keeps head + tail with a reversible marker", () => {
    expect(planClip("short", 100)).toBeUndefined()
    expect(planClip(BIG, 0)).toBeUndefined() // 0 = disabled

    const plan = planClip(BIG, 8000)!
    expect(plan.head.length).toBe(6000) // 75% of budget
    expect(plan.tail.length).toBe(1000) // 12.5%
    expect(plan.head.length + plan.dropped.length + plan.tail.length).toBe(BIG.length)

    const rendered = renderClip(plan, "Bash")
    expect(rendered.startsWith(plan.head)).toBe(true)
    expect(rendered.endsWith(plan.tail)).toBe(true)
    expect(rendered).toContain("…headroom:")
    expect(rendered).toContain("re-run the tool narrower")
    // The result is in the budget's ballpark, not the original's.
    expect(rendered.length).toBeLessThan(BIG.length / 4)
  })

  it("weaves a summary into the marker when given one", () => {
    const plan = planClip(BIG, 8000)!
    expect(renderClip(plan, "Bash", "mostly repeated log lines")).toContain(
      "Summary of the omitted part: mostly repeated log lines",
    )
  })
})

describe("shouldAutoHandoff / estimateTokens", () => {
  it("fires at the threshold; never with an unknown window or pct 0", () => {
    expect(shouldAutoHandoff(850, 1000, 85)).toBe(true)
    expect(shouldAutoHandoff(849, 1000, 85)).toBe(false)
    expect(shouldAutoHandoff(999, 0, 85)).toBe(false)
    expect(shouldAutoHandoff(999, 1000, 0)).toBe(false)
  })
  it("estimates ~4 chars/token", () => {
    expect(estimateTokens(16_000)).toBe(4000)
  })
})

describe("compressToolResults", () => {
  it("clips oversized strings inside tool-result outputs; small ones untouched", async () => {
    const small = toolMsg({ stdout: "ok", exitCode: 0 })
    const big = toolMsg({ stdout: BIG, stderr: "", exitCode: 0 })
    const report = await Effect.runPromise(
      compressToolResults([small, big], 8000),
    )
    expect(outputOf(report.messages[0]!)).toEqual({ stdout: "ok", exitCode: 0 })
    const compressed = outputOf(report.messages[1]!)
    expect((compressed.stdout as string).length).toBeLessThan(10_000)
    expect(compressed.stdout as string).toContain("…headroom:")
    expect(compressed.exitCode).toBe(0) // non-string fields untouched
    expect(report.helperUsage).toBeUndefined() // no UtilityLlm in context
  })

  it("grep-shaped output gets structural per-file grouping, not a blind clip", async () => {
    const flood = Array.from({ length: 60 }, (_, f) =>
      Array.from({ length: 50 }, (_, m) => `src/pkg${f}/mod.ts:${m + 1}:export const v${m} = ${f}`).join("\n"),
    ).join("\n")
    const report = await Effect.runPromise(
      compressToolResults([toolMsg({ output: flood, exitCode: 0 })], 8000),
    )
    const out = outputOf(report.messages[0]!).output as string
    expect(out.length).toBeLessThan(10_000)
    expect(out).toContain("src/pkg0/mod.ts (50 matches, showing 5)")
    expect(out).toContain("…headroom:") // reversible marker present
    expect(out).toContain("matched lines omitted")
    expect(out).toContain("re-run the search narrower")
  })

  it("non-tool messages and string-content messages pass through unchanged", async () => {
    const user: AgentMessage = { role: "user", content: BIG }
    const report = await Effect.runPromise(compressToolResults([user], 8000))
    expect(report.messages[0]).toBe(user)
  })

  it("with UtilityLlm present, the dropped middle gets a FAST digest and usage is reported", async () => {
    const usage = { inputTokens: 900, outputTokens: 40, totalTokens: 940, cacheReadTokens: 0 }
    const seen: { prompt: string | undefined; role: string | undefined } = {
      prompt: undefined,
      role: undefined,
    }
    const utility = Layer.succeed(UtilityLlm, {
      complete: (prompt: string, options?: { role?: "fast" | "cheap" }) => {
        seen.prompt = prompt
        seen.role = options?.role
        return Effect.succeed({ text: "repeated log lines, no errors", usage })
      },
    })
    const report = await Effect.runPromise(
      compressToolResults([toolMsg({ stdout: BIG })], 8000).pipe(Effect.provide(utility)),
    )
    const compressed = outputOf(report.messages[0]!)
    expect(compressed.stdout as string).toContain(
      "Summary of the omitted part: repeated log lines, no errors",
    )
    expect(seen.role).toBe("fast")
    expect(report.helperUsage).toEqual(usage)
  })

  it("a summarizer failure degrades to the plain marker, never fails the pass", async () => {
    const utility = Layer.succeed(UtilityLlm, {
      complete: () => Effect.fail({ _tag: "UtilityLlmError", message: "429" } as never),
    } as never)
    const report = await Effect.runPromise(
      compressToolResults([toolMsg({ stdout: BIG })], 8000).pipe(Effect.provide(utility)),
    )
    const compressed = outputOf(report.messages[0]!)
    expect(compressed.stdout as string).toContain("…headroom:")
    expect(compressed.stdout as string).not.toContain("Summary of the omitted part")
  })
})

describe("runAgentLoop — headroom at append time", () => {
  /** Turn 1: a tool call whose result is huge; turn 2: done. */
  const bigResultModel = () => {
    let calls = 0
    const service = {
      generateText: () => {
        calls++
        if (calls === 1) {
          return Effect.succeed({
            content: [
              { type: "tool-call", id: "c1", name: "Bash", params: { command: "make" } },
              { type: "tool-result", id: "c1", name: "Bash", result: { stdout: BIG, exitCode: 0 } },
            ],
            text: "",
            finishReason: "tool-calls",
            usage: undefined,
          })
        }
        return Effect.succeed({ content: [], text: "done", finishReason: "stop", usage: undefined })
      },
      generateObject: () => Effect.die("unused"),
      streamText: () => Effect.die("unused"),
    }
    return LanguageModel.LanguageModel.of(service as never)
  }

  const noopToolkit = Effect.succeed({
    tools: { Bash: {} },
    handle: () => Effect.succeed({ isFailure: false, result: {}, encodedResult: {} }),
  }) as unknown as Toolkit.Toolkit<Record<string, never>>

  it("the persisted tail is compressed; hooks still see the RAW result", async () => {
    const rawSeen: number[] = []
    const program = runAgentLoop({
      system: "s",
      messages: [{ role: "user", content: "build it" }],
      toolkit: noopToolkit,
      maxSteps: 3,
      toolResultMaxChars: 8000,
      hooks: {
        onAfterToolCall: (e) =>
          Effect.sync(() => {
            rawSeen.push(((e.result as { stdout?: string })?.stdout ?? "").length)
          }),
      },
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, bigResultModel()),
    ) as Effect.Effect<AgentResult, unknown, never>
    const result = await Effect.runPromise(program)
    // The rail/hook consumer received the full output…
    expect(rawSeen).toEqual([BIG.length])
    // …while the buffer (and what the next turn's prompt is built from) holds
    // the clipped form with the reversible marker.
    const toolTail = result.newTail.find((m) => m.role === "tool")!
    const out = outputOf(toolTail)
    expect((out.stdout as string).length).toBeLessThan(10_000)
    expect(out.stdout as string).toContain("…headroom:")
    expect(out.exitCode).toBe(0)
  })

  it("the default budget applies when none is configured", () => {
    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(16_000)
  })
})

describe("properties — planClip / renderClip", () => {
  it("planClip fires iff oversized; the split is lossless; head/tail sizes exact", () => {
    fc.assert(
      fc.property(
        // fullUnicodeString included deliberately: slices can land mid-surrogate
        // and the code-unit concat identity must still hold.
        fc.oneof(fc.string({ maxLength: 400 }), fc.fullUnicodeString({ maxLength: 400 })),
        fc.integer({ min: -10, max: 300 }),
        (text, maxChars) => {
          const plan = planClip(text, maxChars)
          if (maxChars <= 0 || text.length <= maxChars) {
            expect(plan).toBeUndefined()
          } else {
            expect(plan).toBeDefined()
            expect(plan!.head + plan!.dropped + plan!.tail).toBe(text)
            expect(plan!.head.length).toBe(Math.floor(maxChars * 0.75))
            expect(plan!.tail.length).toBe(Math.floor(maxChars * 0.125))
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it("renderClip shrinks oversized text and stays near budget (realistic budgets)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 50_000 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.integer({ min: 512, max: 4096 }),
        (maxChars, unit, extra) => {
          const text = unit.repeat(Math.ceil((maxChars + extra) / unit.length))
          const plan = planClip(text, maxChars)!
          const rendered = renderClip(plan, "Bash")
          expect(rendered.length).toBeLessThan(text.length)
          // head 75% + tail 12.5% + marker (≤ ~220 chars) — 256 is the honest slack.
          expect(rendered.length).toBeLessThanOrEqual(maxChars + 256)
          expect(rendered.startsWith(plan.head)).toBe(true)
          expect(rendered.endsWith(plan.tail)).toBe(true)
          expect(rendered).toContain("…headroom:")
        },
      ),
      { numRuns: 100 },
    )
  })
})
