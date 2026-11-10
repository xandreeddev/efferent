import { describe, expect, test } from "bun:test"
import { Context, Effect, Option, Ref } from "effect"
import { ConversationId, ConversationMemory, harnessCodeOf, MEDIA_LIMITS, openLogSession, RunId, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import { inMemoryLog, memoryConformance } from "@xandreed/core/conformance"
import type { AgentMessage, LogBody, LogEntry, MemoryPolicy, Plugin, RunOrdinal, ToolViews } from "@xandreed/core"
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

// A bound is a fact about what a build shows, never a shorter stored view: the locator a shortened result names must give the whole text back.
test("the memory kit rejects a session that shortens a result's stored view instead of what a build shows", async () => {
  const cutting = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => session.recordTail(tail, {
        ...views,
        view: (tool, encoded, params, isError) => views.view(tool, encoded, params, isError).pipe(
          Effect.map((view) => view.text.length <= 1_000 ? view : { ...view, text: `${view.text.slice(0, 1_000)}\n[shortened]` })),
      }, step, run),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(cutting), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [`${result.failure.check}: ${result.failure.message}`] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["bound-on-write: the result is shown shortened and its entry no longer resolves to the whole view"])
})

// A bound is recorded as the result is written. One recorded by a later write rewrites a request prefix the model was already sent.
test("the memory kit rejects a session that shortens a result at a later write, after a build showed it whole", async () => {
  const late = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => Effect.gen(function* () {
      const session = yield* openLogSession(log, rollingPolicy, { runId })
      // The long results written so far and still shown whole: the next write shortens them.
      const waiting = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      return {
        ...session,
        recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => Effect.gen(function* () {
          const earlier = yield* Ref.getAndSet(waiting, [])
          yield* session.record(earlier.flatMap((entry): ReadonlyArray<LogBody> => entry.body._tag !== "ToolResult" ? [] : [{
            _tag: "Compaction", strategy: rollingPolicy.strategy.id, version: rollingPolicy.strategy.version,
            action: { _tag: "Spill", entry: entry.id, preview: `${entry.body.view.slice(0, 1_000)}\n[shortened]` },
          }]), step)
          const recorded = yield* session.recordTail(tail, views, step, run)
          yield* Ref.set(waiting, recorded.filter((entry) => entry.body._tag === "ToolResult" && entry.body.view.length > 1_000))
          return recorded
        }),
      }
    }),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(late), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [`${result.failure.check}: ${result.failure.message}`] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["bound-on-write: the first build shows the result whole and a build after a later write shows it shortened"])
})

// A bound is a fact of the log. One a session only remembers is gone when the session is opened again, and the same request then rebuilds differently.
test("the memory kit rejects a session that keeps a bound outside the log", async () => {
  const forgetting = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => Effect.gen(function* () {
      const session = yield* openLogSession(log, rollingPolicy, { runId })
      // What this session shows for each long result, by its call: held here, recorded nowhere.
      const shortened = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
      return {
        ...session,
        recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => session.recordTail(tail, views, step, run).pipe(
          Effect.tap((recorded) => Ref.update(shortened, (held) => new Map([...held, ...recorded.flatMap((entry) =>
            entry.body._tag === "ToolResult" && entry.body.view.length > 1_000 ? [[String(entry.body.toolCallId), `${entry.body.view.slice(0, 1_000)}\n[shortened]`] as const] : [])])))),
        build: (options: Parameters<typeof session.build>[0]) => Effect.all([session.build(options), Ref.get(shortened)], { concurrency: 1 }).pipe(Effect.map(([built, held]) => ({
          ...built,
          messages: built.messages.map((message): AgentMessage => message.role !== "tool" ? message : {
            ...message, content: message.content.map((part) => ({ ...part, output: held.get(String(part.toolCallId)) ?? part.output })),
          }),
        }))),
      }
    }),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(forgetting), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [`${result.failure.check}: ${result.failure.message}`] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["bound-on-write: a reopened session shows the shortened result differently"])
})

// Without the run ordinal a build cannot tell another run's call in flight from one the turn left unanswered.
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
  expect(failures.flat()).toEqual(["run-ordinal", "in-flight-exchange"])
})

test("the memory kit rejects a session that ignores the alternate commit", async () => {
  const careless = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      record: (bodies, step) => session.record(bodies, step),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(careless), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["alternate-commit"])
})

test("the memory kit rejects a session that erases the inbox user's provenance", async () => {
  const careless = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      record: (bodies, step, commit) => session.record(bodies.map((body) => {
        if (body._tag !== "Message") return body
        const { inbox: _inbox, ...without } = body
        return without
      }), step, commit),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(careless), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["inbox-intent"])
})

test("the memory kit rejects a session that builds results in the order they were recorded, not their calls'", async () => {
  const careless = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      build: (options) => Effect.all([session.build(options), session.entries], { concurrency: 1 }).pipe(Effect.map(([built, entries]) => {
        // Completion order: each tool message's results as the log holds them.
        const recorded = entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [String(entry.body.toolCallId)] : [])
        return { ...built, messages: built.messages.map((message) => message.role !== "tool" ? message
          : { ...message, content: message.content.toSorted((left, right) => recorded.indexOf(String(left.toolCallId)) - recorded.indexOf(String(right.toolCallId))) }) }
      })),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(careless), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["call-order"])
})

test.each(["all-stable", "negative", "overflow"] as const)("the memory kit rejects a %s stable prefix", async (mistake) => {
  const careless = ConversationMemory.of({
    strategy: rollingPolicy.strategy,
    open: ({ runId, log }) => openLogSession(log, rollingPolicy, { runId }).pipe(Effect.map((session) => ({
      ...session,
      build: (options) => session.build(options).pipe(Effect.map((built) => ({
        ...built,
        stableMessages: mistake === "negative" ? -1 : built.messages.length + (mistake === "overflow" ? 1 : 0),
      }))),
    }))),
  })
  const failures = await Effect.runPromise(Effect.forEach(memoryConformance(careless), (check) =>
    Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
  expect(failures.flat()).toEqual(["stable-messages"])
})
