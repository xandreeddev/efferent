import { LanguageModel, type Toolkit } from "@effect/ai"
import { describe, expect, it } from "bun:test"
import { Context, Effect } from "effect"
import { compressToolResults, Headroom } from "../usecases/headroom.js"
import { runAgentLoop } from "../usecases/agentLoop.js"
import { initialRunContext, RunContextRef } from "../usecases/runContext.js"
import { Compression, type CompressionPolicy, type TailCompressor } from "./Compression.js"
import type { AgentMessage, AgentResult } from "./Conversation.js"

const BIG = "line of log output\n".repeat(3000) // ~57k chars

const toolMsg = (output: unknown): AgentMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "t1", toolName: "Bash", output, isError: false }],
  }) as unknown as AgentMessage

const outputOf = (msg: AgentMessage): Record<string, unknown> =>
  (msg.content as ReadonlyArray<{ output: Record<string, unknown> }>)[0]!.output

// ── building blocks / combinators ──────────────────────────────────────────

describe("Compression.none", () => {
  it("tail passes the buffer through untouched; context is identity (absent)", async () => {
    const msgs = [toolMsg({ stdout: BIG })]
    const report = await Effect.runPromise(Compression.none.tail!(msgs, { maxChars: 8000 }))
    expect(report.messages).toBe(msgs) // same reference — nothing rewritten
    expect(report.helperUsage).toBeUndefined()
    expect(Compression.none.context).toBeUndefined() // identity by absence
  })
})

describe("Headroom.default / Headroom.toolResults", () => {
  it("toolResults() is exactly compressToolResults(tail, budget.maxChars)", async () => {
    const msgs = [toolMsg({ stdout: BIG, exitCode: 0 })]
    const viaHeadroom = await Effect.runPromise(Headroom.toolResults()(msgs, { maxChars: 8000 }))
    const direct = await Effect.runPromise(compressToolResults(msgs, 8000))
    expect(outputOf(viaHeadroom.messages[0]!)).toEqual(outputOf(direct.messages[0]!))
    expect((outputOf(viaHeadroom.messages[0]!).stdout as string)).toContain("…headroom:")
  })

  it("default() = headroom tail + identity context", () => {
    const policy = Headroom.default()
    expect(policy.tail).toBeDefined()
    expect(policy.context).toBeUndefined()
  })
})

describe("Compression.pipeline / when", () => {
  // Two trivial compressors that tag the buffer + report usage, to observe order + summing.
  const tag = (label: string, n: number): TailCompressor => (tail) =>
    Effect.succeed({
      messages: [...tail, { role: "user", content: label } as AgentMessage],
      helperUsage: { inputTokens: n, outputTokens: 0, totalTokens: n, cacheReadTokens: 0 },
    })

  it("pipeline runs steps in order and sums helper usage", async () => {
    const compose = Compression.pipeline(tag("a", 1), tag("b", 2))
    const report = await Effect.runPromise(compose([toolMsg({ stdout: "x" })], { maxChars: 100 }))
    const tail = report.messages.map((m) => m.content)
    expect(tail).toEqual([expect.anything(), "a", "b"]) // order preserved
    expect(report.helperUsage?.totalTokens).toBe(3) // 1 + 2
  })

  it("when applies the step only if the predicate holds, else passes through", async () => {
    const onlyBig = Compression.when((b) => b.maxChars >= 1000, tag("ran", 5))
    const hit = await Effect.runPromise(onlyBig([toolMsg({ stdout: "x" })], { maxChars: 8000 }))
    const miss = await Effect.runPromise(onlyBig([toolMsg({ stdout: "x" })], { maxChars: 10 }))
    expect(hit.messages.some((m) => m.content === "ran")).toBe(true)
    expect(miss.messages.length).toBe(1) // untouched
    expect(miss.helperUsage).toBeUndefined()
  })
})

describe("Headroom.keepRecentToolResults (context strategy)", () => {
  it("elides older tool-result outputs, keeps the most recent N intact", async () => {
    const msgs = [
      toolMsg({ stdout: BIG }), // 0 — oldest, should be elided
      { role: "user", content: "thinking" } as AgentMessage,
      toolMsg({ stdout: BIG }), // 2 — kept (within last 1)
    ]
    const out = await Effect.runPromise(Headroom.keepRecentToolResults(1)(msgs))
    expect(outputOf(out[0]!).stdout as string).toContain("elided from the working context")
    expect(out[1]).toBe(msgs[1]) // non-tool untouched
    expect(outputOf(out[2]!).stdout).toBe(BIG) // recent one intact
  })

  it("no-op when there are <= N tool results", async () => {
    const msgs = [toolMsg({ stdout: BIG })]
    const out = await Effect.runPromise(Headroom.keepRecentToolResults(2)(msgs))
    expect(out).toBe(msgs)
  })
})

// ── the provide story: a custom compressor reaching a service via serviceOption ──

class Marker extends Context.Tag("test/Marker")<Marker, { readonly tag: string }>() {}

describe("custom compressor via Effect.serviceOption (R stays never)", () => {
  // Typed as TailCompressor (R = never) yet still reads an optional service —
  // this only type-checks because serviceOption discharges the requirement.
  const compressor: TailCompressor = (tail) =>
    Effect.gen(function* () {
      const svc = yield* Effect.serviceOption(Marker)
      const note = svc._tag === "Some" ? svc.value.tag : "no-service"
      return { messages: [...tail, { role: "user", content: note } as AgentMessage] }
    })

  it("sees the service when provided at the composition root", async () => {
    const report = await Effect.runPromise(
      compressor([], { maxChars: 100 }).pipe(Effect.provideService(Marker, { tag: "present" })),
    )
    expect(report.messages[0]!.content).toBe("present")
  })

  it("degrades to None when the service is absent", async () => {
    const report = await Effect.runPromise(compressor([], { maxChars: 100 }))
    expect(report.messages[0]!.content).toBe("no-service")
  })
})

// ── loop integration: custom policy on the input, and inheritance via RunContext ──

/** Turn 1: a tool call with a huge result; turn 2: done. */
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

describe("runAgentLoop — compression is an agent property", () => {
  it("an explicit input.compression is used, and its helperUsage reaches onHelperUsage", async () => {
    const usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 0 }
    const customTail: TailCompressor = (tail) =>
      Effect.succeed({
        messages: tail.map((m) =>
          m.role === "tool"
            ? ({ ...m, content: [{ type: "tool-result", toolCallId: "t", toolName: "Bash", output: { custom: true } }] } as unknown as AgentMessage)
            : m,
        ),
        // only report spend on turns that actually carried a tool result (like headroom)
        ...(tail.some((m) => m.role === "tool") ? { helperUsage: usage } : {}),
      })
    const helperSeen: Array<{ total: number }> = []
    const program = runAgentLoop({
      system: "s",
      messages: [{ role: "user", content: "go" }],
      toolkit: noopToolkit,
      maxSteps: 3,
      compression: { tail: customTail },
      hooks: {
        onHelperUsage: (e) => Effect.sync(() => helperSeen.push({ total: e.usage.totalTokens })),
      },
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, bigResultModel())) as Effect.Effect<
      AgentResult,
      unknown,
      never
    >
    const result = await Effect.runPromise(program)
    const toolTail = result.newTail.find((m) => m.role === "tool")!
    expect(outputOf(toolTail)).toEqual({ custom: true }) // the custom compressor ran, not headroom
    expect(helperSeen).toEqual([{ total: 10 }]) // its helperUsage was re-emitted
  })

  it("inherits the policy from RunContext when no input override is given (the sub-agent path)", async () => {
    let called = 0
    const inherited: CompressionPolicy = {
      tail: (tail) =>
        Effect.sync(() => {
          called++
        }).pipe(Effect.as({ messages: tail })), // passthrough, no clipping
    }
    const program = runAgentLoop({
      system: "s",
      messages: [{ role: "user", content: "go" }],
      toolkit: noopToolkit,
      maxSteps: 3,
      toolResultMaxChars: 8000,
      // NOTE: no `compression` here — must come from RunContext.
    }).pipe(
      Effect.locally(RunContextRef, { ...initialRunContext, compression: inherited }),
      Effect.provideService(LanguageModel.LanguageModel, bigResultModel()),
    ) as Effect.Effect<AgentResult, unknown, never>
    const result = await Effect.runPromise(program)
    expect(called).toBeGreaterThan(0) // the RunContext policy ran
    // passthrough means the big output is NOT clipped (proves headroom did not run)
    const toolTail = result.newTail.find((m) => m.role === "tool")!
    expect((outputOf(toolTail).stdout as string).length).toBe(BIG.length)
  })
})
