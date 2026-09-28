import { describe, expect, test } from "bun:test"
import { Context, Effect, Option } from "effect"
import { ConversationMemory, memoryConformance, MemoryLog, openLogSession, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { MemoryPolicy, Plugin } from "@xandreed/core"
import { memoryLogPlugin } from "@xandreed/plugin-memory-log"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

/** A test-only strategy: keep the last two turns, drop the rest. */
const rollingPolicy: MemoryPolicy = {
  strategy: { id: "rolling", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0 } },
  digestOnWrite: Option.none(),
  maintain: ({ turn }) => Effect.succeed({ actions: turn > 2 ? [{ _tag: "DropTurns", throughTurn: turn - 2, ledger: "" }] : [], digest: [] }),
}

const utility = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 } })),
}))

/** Build the log plugin, then the strategy on top of it, the way the graph does. */
const strategyOf = (plugin: Plugin | "rolling") => Effect.gen(function* () {
  const log = yield* memoryLogPlugin.build(memoryLogPlugin.defaults, Context.empty())
  if (plugin === "rolling") {
    const store = Context.get(log as Context.Context<MemoryLog>, MemoryLog)
    return ConversationMemory.of({
      strategy: rollingPolicy.strategy,
      open: ({ conversation, runId, io, services }) => store.open(conversation, io).pipe(Effect.flatMap((handle) => openLogSession(handle, rollingPolicy, { runId, services }))),
    })
  }
  const built = yield* plugin.build(plugin.defaults, log)
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
    const exit = await Effect.runPromise(Effect.either(check.run))
    expect(exit._tag === "Left" ? exit.left.message : "ok").toBe("ok")
  }))
}))
