import { describe, expect, test } from "bun:test"
import { Context, Effect, Option } from "effect"
import { ConversationId, ConversationMemory, harnessCodeOf, MEDIA_LIMITS, openLogSession, RunId, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import { inMemoryLog, memoryConformance } from "@xandreed/core/conformance"
import type { AgentMessage, MemoryPolicy, Plugin, RunOrdinal, ToolViews } from "@xandreed/core"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

/** A failure by its framework code (`harnessCodeOf`), else its tag. */
const codeOf = (error: { readonly _tag: string }): string => Option.getOrElse(harnessCodeOf(error), () => error._tag)

/** A test-only strategy: keep the last two turns, drop the rest. */
const rollingPolicy: MemoryPolicy = {
  strategy: { id: "rolling", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: MEDIA_LIMITS.requestImages, maxChars: MEDIA_LIMITS.requestChars } },
  digestOnWrite: Option.none(),
  maintain: ({ turn }) => Effect.succeed({ actions: turn > 2 ? [{ _tag: "DropTurns", throughTurn: turn - 2, ledger: "" }] : [], digest: [] }),
}

const utility = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })),
}))

/** Build the strategy the way the graph does (it opens over the log it is given). */
const strategyOf = (plugin: Plugin | "rolling") => Effect.gen(function* () {
  if (plugin === "rolling") {
    return ConversationMemory.of({
      strategy: rollingPolicy.strategy,
      open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }),
    })
  }
  const built = yield* plugin.build(plugin.defaults, Context.empty())
  return Context.get(built as Context.Context<ConversationMemory>, ConversationMemory)
})

const strategies: ReadonlyArray<readonly [string, Plugin | "rolling"]> = [
  ["window", memoryWindowPlugin],
  ["summary", memorySummaryPlugin],
  ["rolling (test-only)", "rolling"],
]

strategies.map(([name, plugin]) => describe(`the ${name} strategy conforms to ConversationMemory`, () => {
  const checks = memoryConformance(ConversationMemory.of({
    strategy: { id: name, version: "1" },
    open: (scope) => strategyOf(plugin).pipe(Effect.flatMap((memory) => memory.open(scope))),
  }), utility)
  checks.map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
}))

describe("the summary strategy reads its summarizer where the session is opened", () => {
  test("without a UtilityLlm there, opening fails with memory.summary", async () => {
    const exit = await Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
      const memory = yield* strategyOf(memorySummaryPlugin)
      const stored = yield* inMemoryLog
      return yield* memory.open({ conversation: ConversationId.make("00000000-0000-4000-8000-0000000005a1"), runId: RunId.make("run-1"), log: stored.log })
    }))))
    expect(exit._tag === "Failure" ? codeOf(exit.failure) : "opened").toBe("memory.summary")
  })
})

describe("the attachments check", () => {
  test("refuses a strategy that labels the current turn's image instead of sending it", async () => {
    const textOnly: MemoryPolicy = { ...rollingPolicy, render: { ...rollingPolicy.render, media: { mode: "none", maxImages: MEDIA_LIMITS.requestImages, maxChars: 0 } } }
    const check = memoryConformance(ConversationMemory.of({
      strategy: textOnly.strategy,
      open: ({ runId, log }) => openLogSession(log, textOnly, { runId }),
    })).find((candidate) => candidate.name.startsWith("a message's images"))
    const exit = check === undefined ? undefined : await Effect.runPromise(Effect.result(check.run))
    expect(exit?._tag === "Failure" ? exit.failure.message : "passed").toContain("the current turn's as label")
  })
})

test("the memory kit rejects a session that runs a tool view before storing the raw result", async () => {
  const premature = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => Effect.forEach(
        tail.flatMap((message) => message.role === "tool" ? message.content : []),
        (part) => views.view(part.toolName, part.output, {}, part.isError ?? false),
        { concurrency: 1, discard: true },
      ).pipe(Effect.andThen(session.recordTail(tail, views, step, run))),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(premature), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["raw-result-durable"])
})

test("the memory kit rejects a session that drops the run ordinal from recorded responses and results", async () => {
  const forgetful = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number) => session.recordTail(tail, views, step),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(forgetful), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["run-ordinal"])
})
