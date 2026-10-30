import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { mediaFromBase64, mediaLabel, mediaSlotsOf } from "../domain/media.entity.functions.js"
import { ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogHandle, ToolViews } from "../ports/memory.port.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import type { LogEntry } from "./memory-log.entity.js"
import { openLogSession } from "./memory-session.js"
import type { MemoryPolicy } from "./memory-session.js"

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.some(() => true),
  maintain: () => Effect.succeed({ actions: [], digest: [] }),
}

const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: `VIEW ${String(encoded)}`, version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: () => Effect.succeed(Option.none()),
  digest: (tool, encoded, _params, userMessage) => Effect.succeed(Option.some({
    tool, version: "1", mode: "summarize" as const, instructions: "Summarize.", userMessage, items: [], preserve: [],
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
          Effect.andThen(Effect.sleep(`${delays[task.source] ?? 0} millis`)),
          Effect.andThen(Ref.update(running, (n) => n - 1)),
          Effect.as({ keep: [], summary: Option.some(`DIGEST ${task.source}`) }),
        ),
      })
      const session = yield* openLogSession(log, { ...policy, digestConcurrency: 3 }, { runId: RunId.make("run-1") }).pipe(Effect.provideService(ResultDigester, digester))
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
    expect(outcome.ids).toEqual(["run-1:1", "run-1:2", "run-1:3", "run-1:4", "run-1:5", "run-1:6", "run-1:7", "run-1:8", "run-1:9"])
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
      const session = yield* openLogSession(log, policy, { runId: RunId.make("run-1") }).pipe(Effect.provideService(ResultDigester, digester))
      const before = yield* session.recordTail([results(["a"])], views, 1)
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "first" }) }], 0)
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "second" }) }], 0)
      const after = yield* session.recordTail([results(["b"])], views, 1)
      return { before: before.map((entry) => entry.body._tag), after: after.map((entry) => entry.body._tag), seen: yield* Ref.get(seen) }
    }))
    expect(served.before).toEqual(["ToolResult", "ToolPresentation"])
    expect(served.after).toEqual(["ToolResult", "ToolPresentation", "ToolDigest"])
    expect(served.seen).toEqual(["second"])
  })
})

describe("a tool result's images, as the session records them", () => {
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

  test("checked once: good images keep their slots, a bad one is a label line in the stored view; a failed call sends none", async () => {
    const recorded = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
      const session = yield* openLogSession(log, { ...policy, digestOnWrite: Option.none() }, { runId: RunId.make("run-1") })
      const image = yield* mediaFromBase64(pixelPng, { name: "shot.png" })
      const output = { shot: image, forged: { ...image, bytes: 9 } }
      const imaging: ToolViews = { ...views, view: (_tool, encoded) => Effect.succeed({ text: "two shots", version: "1", subjects: [], artifacts: [], pinned: false, media: mediaSlotsOf(encoded) }) }
      const call = (id: string, isError: boolean): AgentMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make(id), toolName: "shot", output, isError }] })
      return { entries: yield* session.recordTail([call("ok", false), call("failed", true)], imaging, 1), image }
    }))
    const [ok, failed] = recorded.entries.map((entry) => entry.body)
    const unavailable = "[image unavailable: its type, size or fingerprint is not what its data gives; build it with mediaFromBytes]"
    expect(ok?._tag === "ToolResult" ? [ok.view, ok.media?.map((slot) => slot.path), ok.mediaNotes] : []).toEqual([
      `two shots\n${unavailable}`, [["shot"]], [unavailable],
    ])
    expect(failed?._tag === "ToolResult" ? [failed.view, "media" in failed, "mediaNotes" in failed] : []).toEqual(["two shots", false, false])
    expect(mediaLabel(recorded.image)).toContain("shot.png")
  })
})

describe("raw results before host views", () => {
  test("a blocked view cannot hide or lose the settled result on cancellation or reopen", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
      const viewStarted = yield* Deferred.make<void>()
      const held: ToolViews = { ...views, view: () => Deferred.succeed(viewStarted, undefined).pipe(Effect.andThen(Effect.never)) }
      const session = yield* openLogSession(log, { ...policy, digestOnWrite: Option.none() }, { runId: RunId.make("run-1") })
      const writing = yield* session.recordTail([results(["completed operation"])], held, 0).pipe(Effect.forkChild)
      yield* Deferred.await(viewStarted)
      const during = yield* Ref.get(stored)
      yield* Fiber.interrupt(writing)
      const reopened = yield* openLogSession(log, policy, { runId: RunId.make("run-1") })
      return { during, after: yield* reopened.entries, rendered: yield* reopened.transcript("model") }
    })))
    expect(observed.during.flatMap((entry) => entry.body._tag === "ToolResult" ? [entry.body.encoded] : [])).toEqual(["completed operation"])
    expect(observed.after).toEqual(observed.during)
    expect(observed.rendered).toEqual([{ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("call-0"), toolName: "lookup", output: "completed operation", isError: false }] }])
  })

  test("rich views are overlays for queries, resolution, subjects and maintenance while the log keeps one encoded value", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
      const maintained = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const ownPolicy: MemoryPolicy = { ...policy, digestOnWrite: Option.none(), maintain: ({ entries }) => Ref.set(maintained, entries).pipe(Effect.as({ actions: [], digest: [] })) }
      const session = yield* openLogSession(log, ownPolicy, { runId: RunId.make("run-1") })
      const returned = yield* session.recordTail([results(["encoded-only-once"])], views, 0)
      const raw = (yield* session.entries)[0]!
      yield* session.maintain({ phase: "step", lastUsage: Option.none(), budgetTokens: 1000, views })
      return { returned, raw, resolved: yield* session.resolve(raw.id), maintained: yield* Ref.get(maintained), all: yield* session.entries, shown: yield* session.transcript("model") }
    }))
    expect(observed.all.map((entry) => entry.body._tag)).toEqual(["ToolResult", "ToolPresentation"])
    expect(observed.raw.body._tag === "ToolResult" ? observed.raw.body.view : "missing").toBe("encoded-only-once")
    expect(Option.map(observed.resolved, (entry) => entry.body._tag === "ToolResult" ? entry.body.view : "missing")).toEqual(Option.some("VIEW encoded-only-once"))
    expect(observed.maintained[0]?.body._tag === "ToolResult" ? observed.maintained[0].body.view : "missing").toBe("VIEW encoded-only-once")
    expect(observed.all.filter((entry) => entry.body._tag === "ToolPresentation").every((entry) => !("encoded" in entry.body))).toBe(true)
    expect(observed.returned[0]?.body._tag === "ToolResult" ? observed.returned[0].body.view : "missing").toBe("VIEW encoded-only-once")
    expect(observed.shown[0]?.role === "tool" ? observed.shown[0].content[0]?.output : "missing").toBe("VIEW encoded-only-once")
  })
})

test("recordTail preserves an explicit run ordinal on the request and its raw result", async () => {
  const stored = await Effect.runPromise(Effect.gen(function* () {
    const saved = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(saved), append: (entries) => Ref.update(saved, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, policy, { runId: RunId.make("run-1") })
    yield* session.recordTail([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make("c1"), toolName: "lookup", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("c1"), toolName: "lookup", output: "one" }] },
    ], views, 0, RunOrdinal.make(3))
    return yield* Ref.get(saved)
  }))
  expect(stored.flatMap((entry) => entry.body._tag === "Message" || entry.body._tag === "ToolResult" ? [Number(entry.body.run)] : [])).toEqual([3, 3])
})


describe("an uncertain append acknowledgement", () => {
  test("a committed append whose acknowledgement fails repairs cache and numbering before the next write", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const fail = yield* Ref.make(true)
      const log: LogHandle = {
        read: Effect.succeed([]), snapshot: Ref.get(saved),
        append: (entries) => Ref.update(saved, (all) => [...all, ...entries]).pipe(Effect.andThen(Ref.getAndSet(fail, false)),
          Effect.flatMap((first) => first ? Effect.fail(new HarnessError({ code: "test.ack", message: "acknowledgement failed" })) : Effect.void)),
      }
      const session = yield* openLogSession(log, policy, { runId: RunId.make("run-1") })
      const failed = yield* session.record([{ _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: "stored" }] } }], 0).pipe(Effect.result)
      const afterFailure = yield* session.entries
      const next = yield* session.record([{ _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: "next" }] } }], 0)
      return { failed, afterFailure, next, saved: yield* Ref.get(saved) }
    }))
    expect(observed.failed._tag).toBe("Failure")
    expect(observed.afterFailure.map((entry) => String(entry.id))).toEqual(["run-1:0"])
    expect(observed.next.map((entry) => String(entry.id))).toEqual(["run-1:1"])
    expect(observed.saved.map((entry) => String(entry.id))).toEqual(["run-1:0", "run-1:1"])
  })

  test("a proven refusal consumes no id, while an unavailable snapshot reserves uncertain ids across reopening", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const fail = yield* Ref.make(true)
      const append = (entries: ReadonlyArray<LogEntry>) => Ref.getAndSet(fail, false).pipe(Effect.flatMap((first) => first
        ? Effect.fail(new HarnessError({ code: "test.refused", message: "the append was refused" }))
        : Ref.update(saved, (all) => [...all, ...entries])))
      const body = { _tag: "Message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "next" }] } }
      const certain = yield* openLogSession({ read: Ref.get(saved), append }, policy, { runId: RunId.make("run-1") })
      yield* certain.record([body], 0).pipe(Effect.result)
      const certainNext = yield* certain.record([body], 0)
      yield* Ref.set(saved, [])
      yield* Ref.set(fail, true)
      const uncertain = yield* openLogSession({ read: Ref.get(saved), snapshot: Effect.fail(new HarnessError({ code: "test.read", message: "the snapshot is unavailable" })), append }, policy, { runId: RunId.make("run-1") })
      yield* uncertain.record([body], 0).pipe(Effect.result)
      const uncertainNext = yield* uncertain.record([body], 0)
      const reopened = yield* openLogSession({ read: Ref.get(saved), append }, policy, { runId: RunId.make("run-1") })
      const reopenedNext = yield* reopened.record([body], 0)
      return { certainNext, uncertainNext, reopenedNext, saved: yield* Ref.get(saved) }
    }))
    expect(observed.certainNext.map((entry) => String(entry.id))).toEqual(["run-1:0"])
    expect(observed.uncertainNext.map((entry) => String(entry.id))).toEqual(["run-1:1"])
    expect(observed.reopenedNext.map((entry) => String(entry.id))).toEqual(["run-1:2"])
    expect(observed.saved.map((entry) => String(entry.id))).toEqual(["run-1:1", "run-1:2"])
  })
})

describe("view and digest input correlation", () => {
  const checkInputs = (explicitRuns: boolean) => Effect.gen(function* () {
    const saved = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const seenViews = yield* Ref.make<ReadonlyArray<unknown>>([])
    const seenDigests = yield* Ref.make<ReadonlyArray<unknown>>([])
    const log: LogHandle = { read: Ref.get(saved), append: (entries) => Ref.update(saved, (all) => [...all, ...entries]) }
    const scope = { runId: RunId.make("run-1") }
    const session = yield* openLogSession(log, policy, scope).pipe(Effect.provideService(ResultDigester, ResultDigester.of({
      id: "probe", version: "1", digest: () => Effect.succeed({ keep: [], summary: Option.none() }),
    })))
    const ownViews: ToolViews = {
      view: (_tool, _encoded, params) => Ref.update(seenViews, (all) => [...all, params]).pipe(Effect.as({ text: "view", version: "1", subjects: [], artifacts: [], pinned: false })),
      compact: () => Effect.succeed(Option.none()),
      digest: (_tool, _encoded, params) => Ref.update(seenDigests, (all) => [...all, params]).pipe(Effect.as(Option.none())),
    }
    yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "both" }) }], 0)
    const ask = (value: string): AgentMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make("shared"), toolName: "lookup", input: { value } }] })
    const answer = (value: string): AgentMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("shared"), toolName: "lookup", output: value }] })
    yield* session.recordTail([ask("first")], ownViews, 0, explicitRuns ? RunOrdinal.make(0) : undefined)
    yield* session.recordTail([ask("second")], ownViews, explicitRuns ? 0 : 1, explicitRuns ? RunOrdinal.make(1) : undefined)
    yield* session.recordTail([answer("first result")], ownViews, 0, explicitRuns ? RunOrdinal.make(0) : undefined)
    yield* session.recordTail([answer("second result")], ownViews, explicitRuns ? 0 : 1, explicitRuns ? RunOrdinal.make(1) : undefined)
    return { views: yield* Ref.get(seenViews), digests: yield* Ref.get(seenDigests) }
  })

  test("interleaved runs reusing one provider id still present and digest each result with that run's input", async () => {
    expect(await Effect.runPromise(checkInputs(true))).toEqual({ views: [{ value: "first" }, { value: "second" }], digests: [{ value: "first" }, { value: "second" }] })
  })

  test("older requests without run ordinals correlate by preceding turn, step, tool and id", async () => {
    expect(await Effect.runPromise(checkInputs(false))).toEqual({ views: [{ value: "first" }, { value: "second" }], digests: [{ value: "first" }, { value: "second" }] })
  })
})
