import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref } from "effect"
import { ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogHandle, ToolViews } from "../ports/memory.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import type { LogEntry } from "./memory-log.entity.js"
import { openLogSession } from "./memory-session.js"
import type { MemoryPolicy } from "./memory-session.js"

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0 } },
  digestOnWrite: Option.some(() => true),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: `VIEW ${String(encoded)}`, version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: () => Effect.succeed(Option.none()),
  digest: (tool, encoded, _params, userMessage) => Effect.succeed(Option.some({
    tool, version: "1", mode: "summarize" as const, instructions: "Summarize.", userMessage, items: [],
    source: String(encoded), apply: (outcome) => outcome.summary,
  })),
}

const results = (names: ReadonlyArray<string>): AgentMessage => ({
  role: "tool",
  content: names.map((name, index) => ({ type: "tool-result" as const, toolCallId: ToolCallId.make(`call-${index}`), toolName: "lookup", output: name })),
})

describe("the log session", () => {
  test("digests run concurrently and are recorded in the order of their results", async () => {
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
      const running = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      // The first result digests slowest, so completion order is the reverse of result order.
      const delays: Readonly<Record<string, number>> = { a: 30, b: 20, c: 10 }
      const digester = ResultDigester.of({
        id: "slow", version: "1",
        digest: (task) => Ref.updateAndGet(running, (n) => n + 1).pipe(
          Effect.flatMap((now) => Ref.update(peak, (max) => Math.max(max, now))),
          Effect.zipRight(Effect.sleep(`${delays[task.source] ?? 0} millis`)),
          Effect.zipRight(Ref.update(running, (n) => n - 1)),
          Effect.as({ keep: [], summary: Option.some(`DIGEST ${task.source}`) }),
        ),
      })
      const session = yield* openLogSession(log, { ...policy, digestConcurrency: 3 }, { runId: "run-1" }).pipe(Effect.provideService(ResultDigester, digester))
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "look up a, b and c" }) }], 0)
      const recorded = yield* session.recordTail([results(["a", "b", "c"])], views, 1)
      return {
        peak: yield* Ref.get(peak),
        digests: recorded.flatMap((entry) => entry.body._tag === "ToolDigest" ? [entry.body.text] : []),
        ids: recorded.map((entry) => String(entry.id)),
      }
    }))
    expect(outcome.peak).toBe(3)
    expect(outcome.digests).toEqual(["DIGEST a", "DIGEST b", "DIGEST c"])
    expect(outcome.ids).toEqual(["run-1:1", "run-1:2", "run-1:3", "run-1:4", "run-1:5", "run-1:6"])
  })

  test("digests serve the latest user message; a log without one digests nothing", async () => {
    const served = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const digester = ResultDigester.of({
        id: "echo", version: "1",
        digest: (task) => Ref.update(seen, (all) => [...all, task.userMessage.text]).pipe(Effect.as({ keep: [], summary: Option.some("DIGEST") })),
      })
      const session = yield* openLogSession(log, policy, { runId: "run-1" }).pipe(Effect.provideService(ResultDigester, digester))
      const before = yield* session.recordTail([results(["a"])], views, 1)
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "first" }) }], 0)
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "second" }) }], 0)
      const after = yield* session.recordTail([results(["b"])], views, 1)
      return { before: before.map((entry) => entry.body._tag), after: after.map((entry) => entry.body._tag), seen: yield* Ref.get(seen) }
    }))
    expect(served.before).toEqual(["ToolResult"])
    expect(served.after).toEqual(["ToolResult", "ToolDigest"])
    expect(served.seen).toEqual(["second"])
  })
})
