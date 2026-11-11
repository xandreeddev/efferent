import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { mediaFromBase64, mediaLabel, mediaSlotsOf } from "../domain/media.entity.functions.js"
import { ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogHandle, ToolViews } from "../ports/memory.port.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import { userRoleMessageOf } from "../turn/user-message.entity.functions.js"
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

test("an alternate commit serializes prepared ids with ordinary appends and rejects a whole batch without consuming ids", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, policy, { runId: RunId.make("run-1") })
    yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "first" }) }], 0)
    const messages = ["steer one", "steer two"].map((text) => ({ _tag: "Message" as const, message: { role: "user" as const, content: text } }))
    const rejected = yield* session.record(messages, 1, () => Effect.succeed(false))
    const committing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const alternative = yield* Effect.forkChild(session.record(messages, 1, (prepared) => Deferred.succeed(committing, undefined).pipe(
      Effect.andThen(Deferred.await(release)), Effect.andThen(log.append(prepared)), Effect.as(true),
    )))
    yield* Deferred.await(committing)
    const ordinary = yield* Effect.forkChild(session.record([{ _tag: "Message", message: { role: "user", content: "host note" } }], 1))
    const pending = yield* Effect.gen(function* () {
      const beforeCommit = yield* session.entries
      yield* Deferred.succeed(release, undefined)
      return { beforeCommit, alternate: yield* Fiber.join(alternative), ordinary: yield* Fiber.join(ordinary) }
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    return { rejected, ...pending, stored: yield* log.read, cache: yield* session.entries }
  })).pipe(Effect.timeout("3 seconds")))
  expect(observed.rejected).toEqual([])
  expect(observed.beforeCommit).toHaveLength(1)
  expect(observed.alternate.map((entry) => String(entry.id))).toEqual(["run-1:1", "run-1:2"])
  expect(observed.ordinary.map((entry) => String(entry.id))).toEqual(["run-1:3"])
  expect(observed.cache).toEqual(observed.stored)
  expect(observed.stored).toHaveLength(4)
})

test("write and compaction digests serve the newest actual inbox user intent, including images, while correctives remain host text", async () => {
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
    const seen = yield* Ref.make<ReadonlyArray<UserMessage>>([])
    const ownPolicy: MemoryPolicy = { ...policy, maintain: ({ entries }) => Effect.succeed({ actions: [], digest: entries.filter((entry) => entry.body._tag === "ToolResult").map((entry) => entry.id) }) }
    const session = yield* openLogSession(log, ownPolicy, { runId: RunId.make("run-1") }).pipe(Effect.provideService(ResultDigester, ResultDigester.of({
      id: "intent", version: "1", digest: (task) => Ref.update(seen, (all) => [...all, task.userMessage]).pipe(Effect.as({ keep: [], summary: Option.some("digest") })),
    })))
    const pixel = yield* mediaFromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
    const intent = new UserMessage({ text: "focus on this image", attachments: [pixel] })
    yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "first request" }) }], 0)
    yield* session.record([{ _tag: "Message", inbox: InboxItemId.make("steer"), run: RunOrdinal.make(0), message: userRoleMessageOf(intent) }], 1)
    yield* session.recordTail([{ role: "user", content: "host corrective" }], views, 1)
    yield* session.recordTail([results(["found"])], views, 1)
    yield* session.recordTail([{ role: "user", content: "another corrective" }], views, 2)
    yield* session.maintain({ phase: "step", lastUsage: Option.none(), budgetTokens: 100_000, views })
    return { intent, seen: yield* Ref.get(seen) }
  }))
  expect(observed.seen).toEqual([observed.intent, observed.intent])
})

test("maintenance renders its explicit run, placement and turn-end without obsolete context", async () => {
  const shown = await Effect.runPromise(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const rendered = yield* Ref.make<ReadonlyArray<string>>([])
    const log: LogHandle = { read: Ref.get(stored), append: entries => Ref.update(stored, all => [...all, ...entries]) }
    const session = yield* openLogSession(log, { ...policy, maintain: ({ entries, render }) => Ref.update(rendered, all => [...all, JSON.stringify(render(entries))]).pipe(Effect.as({ actions: [], digest: [] })) }, { runId: RunId.make("scope") })
    yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "question" }) },
      { _tag: "StepContext", run: RunOrdinal.make(0), step: 0, text: "FIRST" },
      { _tag: "StepContext", run: RunOrdinal.make(1), step: 0, text: "SECOND" }], 0)
    const base = { lastUsage: Option.none(), budgetTokens: 100_000, views }
    yield* session.maintain({ ...base, phase: "step", render: { run: RunOrdinal.make(0), stepContext: "tail" } })
    yield* session.maintain({ ...base, phase: "step", render: { run: RunOrdinal.make(0), stepContext: "none" } })
    yield* session.maintain({ ...base, phase: "turn-end", render: { run: RunOrdinal.make(1), stepContext: "tail" } })
    yield* session.maintain({ ...base, phase: "turn-end" })
    yield* session.maintain({ ...base, phase: "step" })
    return yield* Ref.get(rendered)
  }))
  expect(shown.map(text => text.includes("FIRST"))).toEqual([true, false, false, false, false])
  expect(shown.map(text => text.includes("SECOND"))).toEqual([false, false, false, false, true])
})

describe("a result bounded as it is written", () => {
  /** A strategy that bounds what a result shows at 100 characters and digests nothing. */
  const bounding: MemoryPolicy = { ...policy, digestOnWrite: Option.none(), boundOnWriteChars: 100 }
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const text = (encoded: unknown): string => typeof encoded === "string" ? encoded : "y".repeat(500)
  /** A tool's view is its result as it is; `own` gives the tools that set a bound of their own, `pinned` the pinned ones. */
  const plain = (own: Readonly<Record<string, number>> = {}, pinned: ReadonlyArray<string> = []): ToolViews => ({
    ...views,
    view: (tool, encoded) => Effect.succeed({
      text: text(encoded), version: "1", subjects: [], artifacts: [], pinned: pinned.includes(tool),
      ...(Object.hasOwn(own, tool) ? { boundOnWriteChars: own[tool] } : {}),
      ...(typeof encoded === "string" ? {} : { media: mediaSlotsOf(encoded) }),
    }),
  })
  const exchange = (id: string, tool: string, output: unknown, isError = false): ReadonlyArray<AgentMessage> => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(id), toolName: tool, input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make(id), toolName: tool, output, isError }] },
  ]
  const notice = (left: number, locator: string, offset: number) =>
    `[… ${left} more characters kept out of context; call recall_context with locator "${locator}" and offset ${offset} to read them]`
  /** The bounds a tail recorded: the entry each one shortens and the text it shows. */
  const boundsOf = (entries: ReadonlyArray<LogEntry>) => entries.flatMap((entry) =>
    entry.body._tag === "Compaction" && entry.body.action._tag === "Spill" ? [{ strategy: entry.body.strategy, version: entry.body.version, entry: String(entry.body.action.entry), preview: entry.body.action.preview }] : [])
  /** What a build shows for each tool result, in order. */
  const outputsOf = (messages: ReadonlyArray<AgentMessage>) => messages.flatMap((message) => message.role === "tool" ? message.content.map((part) => part.output) : [])
  const opened = (ownPolicy: MemoryPolicy) => Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
    const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }
    const session = yield* openLogSession(log, ownPolicy, { runId: RunId.make("run-1") })
    yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "look it up" }) }], 0)
    return { stored, log, session }
  })
  const build = { stepContext: "none" as const, run: RunOrdinal.make(0) }

  test("a result longer than the bound is recorded with its preview before any build shows it", async () => {
    const whole = "x".repeat(500)
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { stored, session } = yield* opened(bounding)
      const recorded = yield* session.recordTail(exchange("c1", "lookup", whole), plain(), 1)
      // The bound is in the log when the write returns: no build can come between the result and it.
      const durable = yield* Ref.get(stored)
      const built = yield* session.build(build)
      return { recorded, durable, built, resolved: yield* session.resolve(recorded[1]!.id) }
    }))
    expect(observed.recorded.map((entry) => entry.body._tag)).toEqual(["Message", "ToolResult", "ToolPresentation", "Compaction"])
    const preview = `${"x".repeat(100)}\n${notice(400, "run-1:2", 100)}`
    expect(boundsOf(observed.recorded)).toEqual([{ strategy: "test", version: "1", entry: "run-1:2", preview }])
    expect(boundsOf(observed.durable)).toEqual(boundsOf(observed.recorded))
    expect(outputsOf(observed.built.messages)).toEqual([preview])
    expect(observed.built.compactions.map(String)).toEqual(["run-1:4"])
    // The stored result stays whole, and it is what a locator resolves to.
    expect(observed.durable.flatMap((entry) => entry.body._tag === "ToolResult" ? [entry.body.encoded] : [])).toEqual([whole])
    expect(Option.map(observed.resolved, (entry) => entry.body._tag === "ToolResult" ? entry.body.view : "missing")).toEqual(Option.some(whole))
  })

  test("the prefix holding a bounded result is identical on every later build", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { log, session } = yield* opened(bounding)
      yield* session.recordTail(exchange("c1", "lookup", "a".repeat(500)), plain(), 1)
      const first = yield* session.build(build)
      yield* session.recordTail(exchange("c2", "lookup", "b".repeat(700)), plain(), 2)
      const second = yield* session.build(build)
      yield* session.maintain({ phase: "step", lastUsage: Option.none(), budgetTokens: 1, views: plain() })
      yield* session.recordTail([{ role: "assistant", content: [{ type: "text", text: "both read" }] }], plain(), 3)
      const third = yield* session.build(build)
      const reopened = yield* openLogSession(log, bounding, { runId: RunId.make("run-1") })
      return { first, second, third, rebuilt: yield* reopened.build(build) }
    }))
    const { first, second, third, rebuilt } = observed
    expect(outputsOf(first.messages)).toEqual([`${"a".repeat(100)}\n${notice(400, "run-1:2", 100)}`])
    expect(first.messages).toHaveLength(3)
    expect(second.messages.slice(0, first.messages.length)).toEqual([...first.messages])
    expect(third.messages.slice(0, second.messages.length)).toEqual([...second.messages])
    expect(outputsOf(third.messages)[1]).toBe(`${"b".repeat(100)}\n${notice(600, "run-1:6", 100)}`)
    expect(rebuilt.fingerprint).toBe(third.fingerprint)
  })

  test("a digest no longer than the bound is shown instead of a preview", async () => {
    const digesting = (summary: string, digests: boolean) => Effect.gen(function* () {
      const { session } = yield* opened({ ...bounding, digestOnWrite: Option.some(() => true), render: { ...bounding.render, digests } }).pipe(
        Effect.provideService(ResultDigester, ResultDigester.of({ id: "fixed", version: "1", digest: () => Effect.succeed({ keep: [], summary: Option.some(summary) }) })))
      const recorded = yield* session.recordTail(exchange("c1", "lookup", "x".repeat(500)), plain(), 1)
      return { tags: recorded.map((entry) => entry.body._tag), bounds: boundsOf(recorded).map((bound) => bound.preview), shown: outputsOf((yield* session.build(build)).messages) }
    })
    const preview = `${"x".repeat(100)}\n${notice(400, "run-1:2", 100)}`
    expect(await Effect.runPromise(digesting("d".repeat(100), true))).toEqual({ tags: ["Message", "ToolResult", "ToolPresentation", "ToolDigest"], bounds: [], shown: ["d".repeat(100)] })
    // A digest longer than the bound gives way to the preview of the view, and so does one the render does not show.
    expect(await Effect.runPromise(digesting("d".repeat(101), true))).toEqual({ tags: ["Message", "ToolResult", "ToolPresentation", "ToolDigest", "Compaction"], bounds: [preview], shown: [preview] })
    expect(await Effect.runPromise(digesting("d".repeat(10), false))).toEqual({ tags: ["Message", "ToolResult", "ToolPresentation", "ToolDigest", "Compaction"], bounds: [preview], shown: [preview] })
  })

  test("a pinned result, a recall page, a result with images and a tool with bound 0 stay whole", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { session } = yield* opened(bounding)
      const image = yield* mediaFromBase64(pixelPng, { name: "shot.png" })
      const whole = "x".repeat(500)
      const recorded = yield* session.recordTail([
        ...exchange("c1", "keep", whole), ...exchange("c2", "recall_context", whole), ...exchange("c3", "shot", { shot: image }),
        ...exchange("c4", "paged", whole), ...exchange("c5", "lookup", whole),
      ], plain({ paged: 0 }, ["keep"]), 1)
      return { recorded, shown: outputsOf((yield* session.build(build)).messages) }
    }))
    // Only the ordinary result of the same tail is bounded: the others are whole in the build.
    expect(boundsOf(observed.recorded).map((bound) => bound.entry)).toEqual(["run-1:10"])
    const whole = "x".repeat(500)
    expect(observed.shown.slice(0, 2)).toEqual([whole, whole])
    expect(String(observed.shown[2]).startsWith("y".repeat(500))).toBe(true)
    expect(observed.shown.slice(3)).toEqual([whole, `${"x".repeat(100)}\n${notice(400, "run-1:10", 100)}`])
  })

  test("a tool's own bound overrides the policy's", async () => {
    const shown = await Effect.runPromise(Effect.gen(function* () {
      const { session } = yield* opened(bounding)
      yield* session.recordTail([...exchange("c1", "wide", "w".repeat(500)), ...exchange("c2", "narrow", "n".repeat(500)), ...exchange("c3", "wide", "w".repeat(300))], plain({ wide: 300, narrow: 20 }), 1)
      return outputsOf((yield* session.build(build)).messages)
    }))
    expect(shown).toEqual([
      `${"w".repeat(300)}\n${notice(200, "run-1:2", 300)}`,
      `${"n".repeat(20)}\n${notice(480, "run-1:4", 20)}`,
      "w".repeat(300),
    ])
  })

  test("a policy without a bound records none", async () => {
    const recordedUnder = (ownPolicy: MemoryPolicy) => Effect.gen(function* () {
      const { session } = yield* opened(ownPolicy)
      // A tool's own bound alone bounds nothing: the notice names a tool only a bounding strategy contributes.
      const recorded = yield* session.recordTail([...exchange("c1", "lookup", "x".repeat(500)), ...exchange("c2", "narrow", "n".repeat(500))], plain({ narrow: 20 }), 1)
      return { bounds: boundsOf(recorded), shown: outputsOf((yield* session.build(build)).messages) }
    })
    const whole = { bounds: [], shown: ["x".repeat(500), "n".repeat(500)] }
    expect(await Effect.runPromise(recordedUnder({ ...policy, digestOnWrite: Option.none() }))).toEqual(whole)
    expect(await Effect.runPromise(recordedUnder({ ...bounding, boundOnWriteChars: 0 }))).toEqual(whole)
  })

  test("a result is left whole when its preview would not be shorter, and a failed call's result is bounded like any other", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { session } = yield* opened(bounding)
      // 101 characters under a bound of 100: the notice alone is longer than the one character it would leave out.
      const recorded = yield* session.recordTail([...exchange("c1", "lookup", "x".repeat(101)), ...exchange("c2", "lookup", "e".repeat(500), true)], plain(), 1)
      return { bounds: boundsOf(recorded).map((bound) => bound.entry), built: yield* session.build(build) }
    }))
    expect(observed.bounds).toEqual(["run-1:4"])
    expect(outputsOf(observed.built.messages)).toEqual(["x".repeat(101), `${"e".repeat(100)}\n${notice(400, "run-1:4", 100)}`])
  })

  test("a bound that would split a surrogate pair is cut before it, and the notice gives that offset", async () => {
    // The pair sits across unit 100, where the bound cuts.
    const whole = `${"x".repeat(99)}\u{1F600}${"y".repeat(400)}`
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { session } = yield* opened(bounding)
      const recorded = yield* session.recordTail(exchange("c1", "lookup", whole), plain(), 1)
      return { previews: boundsOf(recorded).map((bound) => bound.preview), resolved: yield* session.resolve(recorded[1]!.id) }
    }))
    expect(observed.previews).toEqual([`${"x".repeat(99)}\n${notice(whole.length - 99, "run-1:2", 99)}`])
    expect(Option.map(observed.resolved, (entry) => entry.body._tag === "ToolResult" ? entry.body.view.slice(99) : "missing")).toEqual(Option.some(whole.slice(99)))
  })

  test("a write interrupted or failed between the result and its bound leaves the result whole in every later build, also after a reopen", async () => {
    const whole = "x".repeat(500)
    /** Stop the write of one long result after its raw append and before its bound; then write on, build twice and reopen. */
    const stoppedBy = (stop: "interruption" | "a failed view" | "a failed append") => Effect.gen(function* () {
      const stored = yield* Ref.make<ReadonlyArray<LogEntry>>([])
      const refusing = yield* Ref.make(stop === "a failed append")
      // The log refuses the bound's append once: the raw result is stored by then.
      const log: LogHandle = { read: Ref.get(stored), append: (entries) => Ref.get(refusing).pipe(Effect.flatMap((refuse) =>
        refuse && entries.some((entry) => entry.body._tag === "Compaction")
          ? Ref.set(refusing, false).pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "test.refused", message: "the append was refused" }))))
          : Ref.update(stored, (all) => [...all, ...entries]))) }
      const session = yield* openLogSession(log, bounding, { runId: RunId.make("run-1") })
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "look it up" }) }], 0)
      const viewing = yield* Deferred.make<void>()
      const stopping: ToolViews = stop === "a failed append" ? plain() : { ...plain(), view: () => stop === "interruption"
        ? Deferred.succeed(viewing, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.die("the view failed") }
      const writing = yield* session.recordTail(exchange("c1", "lookup", whole), stopping, 1).pipe(Effect.forkChild)
      if (stop === "interruption") yield* Deferred.await(viewing).pipe(Effect.andThen(Fiber.interrupt(writing)))
      const exit = yield* Fiber.await(writing)
      const first = yield* session.build(build)
      // A later write of the same session records its own bound and none for the result the stopped write left.
      yield* session.recordTail(exchange("c2", "lookup", "z".repeat(500)), plain(), 2)
      const second = yield* session.build(build)
      const reopened = yield* openLogSession(log, bounding, { runId: RunId.make("run-1") })
      yield* reopened.recordTail([{ role: "assistant", content: [{ type: "text", text: "both read" }] }], plain(), 3)
      const third = yield* reopened.build(build)
      return {
        stopped: exit._tag === "Failure",
        bounded: boundsOf(yield* Ref.get(stored)).map((bound) => bound.entry),
        shown: [first, second, third].map((built) => outputsOf(built.messages)),
      }
    })
    // Only the later result has a bound: nothing records one for the result the stopped write left.
    const later = (locator: string) => `${"z".repeat(100)}\n${notice(400, locator, 100)}`
    const left = (locator: string) => ({ stopped: true, bounded: [locator], shown: [[whole], [whole, later(locator)], [whole, later(locator)]] })
    expect(await Effect.runPromise(stoppedBy("interruption"))).toEqual(left("run-1:4"))
    expect(await Effect.runPromise(stoppedBy("a failed view"))).toEqual(left("run-1:4"))
    // Here the first result's presentation was stored before its bound was refused, so the later result is one entry further.
    expect(await Effect.runPromise(stoppedBy("a failed append"))).toEqual(left("run-1:5"))
  })

  describe("with cutAtLineBreaks", () => {
    /** The same strategy, cutting at line breaks. */
    const cutting: MemoryPolicy = { ...bounding, cutAtLineBreaks: true }
    /** Rows of 13 characters: the bound of 100 falls 9 characters into the eighth, a bound of 300 one character into the twenty-fourth. */
    const rows = (count: number): string => Array.from({ length: count }, (_, index) => `row ${String(index).padStart(4, "0")} abc\n`).join("")

    test("a result of whole lines is bounded after the last line that fits, and the notice gives that offset", async () => {
      const whole = rows(40)
      const observed = await Effect.runPromise(Effect.gen(function* () {
        const { stored, log, session } = yield* opened(cutting)
        const recorded = yield* session.recordTail(exchange("c1", "lookup", whole), plain(), 1)
        const first = yield* session.build(build)
        yield* session.recordTail(exchange("c2", "lookup", "b".repeat(700)), plain(), 2)
        const second = yield* session.build(build)
        const reopened = yield* openLogSession(log, cutting, { runId: RunId.make("run-1") })
        return { recorded, durable: yield* Ref.get(stored), first, second, rebuilt: yield* reopened.build(build), resolved: yield* session.resolve(recorded[1]!.id) }
      }))
      // Seven rows, 91 characters: the nine characters of the eighth row that the bound would have kept are left for the page that follows.
      const preview = `${whole.slice(0, 91)}\n${notice(429, "run-1:2", 91)}`
      expect(whole.slice(0, 91)).toBe(rows(7))
      expect(boundsOf(observed.recorded)).toEqual([{ strategy: "test", version: "1", entry: "run-1:2", preview }])
      expect(boundsOf(observed.durable).at(0)).toEqual(boundsOf(observed.recorded)[0])
      // The first build shows it so, and every later build and a reopened session show the same prefix.
      expect(outputsOf(observed.first.messages)).toEqual([preview])
      expect(observed.second.messages.slice(0, observed.first.messages.length)).toEqual([...observed.first.messages])
      expect(observed.rebuilt.fingerprint).toBe(observed.second.fingerprint)
      // A result with no line break is cut at the bound, as without the option.
      expect(outputsOf(observed.second.messages)[1]).toBe(`${"b".repeat(100)}\n${notice(600, "run-1:6", 100)}`)
      // The stored result stays whole.
      expect(Option.map(observed.resolved, (entry) => entry.body._tag === "ToolResult" ? entry.body.view : "missing")).toEqual(Option.some(whole))
    })

    test("a tool's own bound is cut after a whole line too; a line break further back than a quarter of the bound is not used", async () => {
      // One line break at 60: 40 characters short of the bound, more than the 25 a quarter allows.
      const early = `${"e".repeat(60)}\n${"f".repeat(439)}`
      const shown = await Effect.runPromise(Effect.gen(function* () {
        const { session } = yield* opened(cutting)
        yield* session.recordTail([...exchange("c1", "wide", rows(40)), ...exchange("c2", "lookup", early)], plain({ wide: 300 }), 1)
        return outputsOf((yield* session.build(build)).messages)
      }))
      expect(shown).toEqual([
        `${rows(23)}\n${notice(520 - 299, "run-1:2", 299)}`,
        `${early.slice(0, 100)}\n${notice(400, "run-1:4", 100)}`,
      ])
    })

    test("a policy that does not set it cuts the same rows at the bound, inside a line", async () => {
      const whole = rows(40)
      const shownUnder = (ownPolicy: MemoryPolicy) => Effect.runPromise(Effect.gen(function* () {
        const { session } = yield* opened(ownPolicy)
        yield* session.recordTail(exchange("c1", "lookup", whole), plain(), 1)
        return outputsOf((yield* session.build(build)).messages)
      }))
      const atTheBound = [`${whole.slice(0, 100)}\n${notice(420, "run-1:2", 100)}`]
      expect(await shownUnder(bounding)).toEqual(atTheBound)
      expect(await shownUnder({ ...bounding, cutAtLineBreaks: false })).toEqual(atTheBound)
      expect(whole.slice(91, 100)).toBe("row 0007 ")
    })

    test("a result a little longer than the bound is left whole at the character limit, and bounded at a line break", async () => {
      // 12,000 characters, a line break and 4,049 more: 16,050, fifty past a bound of 16,000.
      const whole = `${"a".repeat(12_000)}\n${"b".repeat(4_049)}`
      const recordedUnder = (ownPolicy: MemoryPolicy) => Effect.runPromise(Effect.gen(function* () {
        const { session } = yield* opened({ ...ownPolicy, boundOnWriteChars: 16_000 })
        const recorded = yield* session.recordTail(exchange("c1", "lookup", whole), plain(), 1)
        return { bounds: boundsOf(recorded).length, shown: outputsOf((yield* session.build(build)).messages) }
      }))
      // At the character limit the preview, 16,000 characters and the notice, would be longer than the view: the result is left whole.
      expect(await recordedUnder(bounding)).toEqual({ bounds: 0, shown: [whole] })
      // Cut after the line break, 3,999 characters back, the preview is shorter than the view: the result is bounded where it was whole.
      expect(await recordedUnder(cutting)).toEqual({ bounds: 1, shown: [`${whole.slice(0, 12_001)}\n${notice(4_049, "run-1:2", 12_001)}`] })
    })
  })
})
