import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref } from "effect"
import {
  ConversationId, InboxItemId, InvocationId, KnowledgeError, KnowledgeSourceId, RunId, RunOrdinal, SectionId, SessionLogError, Sessions, ToolCallId, frameworkDraft,
} from "@xandreed/core"
import { capturedTurnText, splitCapturedEvidence } from "./memory-capture.adapter.js"
import { admissionLog, admittingWith, appendCapturedEntries, captureAddress, capturedEntry, captureRun, closeCaptureTurn, makeCaptureFixture, openCaptureTurn } from "./memory-capture.testing.js"

const callId = ToolCallId.make("reused")
const call = (index: number, target: string, ordinal: number, tool = "deliver") => capturedEntry(index, { _tag: "Message", run: RunOrdinal.make(ordinal), message: { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: tool, input: { target } }] } })
const result = (index: number, ordinal: number, tool = "deliver", view = "{\"delivered\":false}") => capturedEntry(index, { _tag: "ToolResult", run: RunOrdinal.make(ordinal), toolCallId: callId, toolName: tool, isError: false, encoded: { delivered: false }, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false })

describe("committed conversation capture", () => {
  test("reused pairing ids correlate arguments by loop run, step and tool, and receipts do not establish domain effects", () => {
    const entries = [call(1, "first", 0), call(2, "wrong", 1, "other"), result(3, 0), call(4, "second", 1), result(5, 1)]
    expect(capturedTurnText(entries, [{ invocationId: InvocationId.make("capture:call:1"), toolCallId: callId, tool: "deliver", step: 0, ok: true }])).toBe('Tool result: deliver\nPairing key: "reused"\nStep: 0\nLoop run: 0\nRecorded outcome: returned a result\nArguments: {"target":"first"}\nRecorded result: {"delivered":false}\n\nTool result: deliver\nPairing key: "reused"\nStep: 0\nLoop run: 1\nRecorded outcome: returned a result\nArguments: {"target":"second"}\nRecorded result: {"delivered":false}\n\nTool handler receipt: deliver\nInvocation: capture:call:1\nPairing key: "reused"\nStep: 0\nHandler outcome: returned a result\nA handler receipt alone does not confirm a real-world effect; inspect the recorded domain result.')
  })

  test("failed turns retain returned tool evidence while excluding retrieved context and preserving steering", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    const writer = yield* openCaptureTurn(fixture.sessions)
    yield* appendCapturedEntries(writer, [
      call(1, "destination", 0), result(2, 0),
      capturedEntry(3, { _tag: "Message", inbox: InboxItemId.make("steer"), message: { role: "user", content: "Actually use the blue record." } }),
      capturedEntry(4, { _tag: "TurnContext", sectionId: SectionId.make("memory.recalled"), version: "1", text: "EXCLUDED SECTION" }),
      capturedEntry(5, { _tag: "StepContext", step: 0, run: RunOrdinal.make(0), text: "EXCLUDED STEP" }),
      result(6, 0, "recall_memory", "EXCLUDED MEMORY"), result(7, 0, "search_knowledge", "EXCLUDED RAG"),
    ])
    yield* writer.append([frameworkDraft("tool.completed", { invocationId: "capture-fixture:call:1", toolCallId: "reused", tool: "deliver", step: 0, ok: true, durationMs: 1, labels: { private: "EXCLUDED HOST METADATA" }, stage: null })])
    yield* writer.end({ reason: "failed", failure: Option.some({ code: "fixture.failed", message: "Later work failed" }) })
    const capture = yield* fixture.build({ pageSize: 2 })
    const synced = yield* capture.sync(captureAddress)
    expect(synced.sources).toBe(1)
    const source = (yield* Ref.get(fixture.calls))[0]!.source
    expect(source.text).toContain('Arguments: {"target":"destination"}')
    expect(source.text).toContain('Recorded result: {"delivered":false}')
    expect(source.text).toContain("Handler outcome: returned a result")
    expect(source.text).toContain("User: Actually use the blue record.")
    expect(source.text).not.toContain("EXCLUDED")
    expect(source.metadata.episode).toBe(`conversation:${captureAddress.id}:${captureRun}`)
    expect(synced.hasMore).toBe(false)
  }))))

  test("part offsets cover all source text and share one episode instead of counting chunks as routines", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    const writer = yield* openCaptureTurn(fixture.sessions)
    yield* closeCaptureTurn(writer, "Long 🙂 evidence ".repeat(30))
    const capture = yield* fixture.build({ maxSourceChars: 31, pageSize: 1 })
    const synced = yield* capture.sync(captureAddress)
    const sources = (yield* Ref.get(fixture.calls)).map((input) => input.source)
    expect(synced.sources).toBe(sources.length)
    expect(sources.length).toBeGreaterThan(2)
    expect(new Set(sources.map((source) => source.metadata.episode)).size).toBe(1)
    const combined = sources.map((source) => source.text).join("")
    sources.forEach((source) => {
      const start = Number(source.metadata.offset)
      const end = Number(source.metadata.end)
      expect(source.text).toBe(combined.slice(start, end))
      expect(source.text.length).toBeLessThanOrEqual(31)
      expect(source.metadata.totalChars).toBe(combined.length)
    })
    expect(combined).toBe(`User: Please update the record.\n\nAssistant final reply: ${"Long 🙂 evidence ".repeat(30)}`)
    expect((yield* capture.sync(captureAddress)).sources).toBe(0)
    expect(splitCapturedEvidence("a🙂b", 2).map((part) => part.text)).toEqual(["a", "🙂", "b"])
  }))))

  test("page limits and open turns report stalled progress without acknowledging ahead", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    const writer = yield* openCaptureTurn(fixture.sessions)
    const small = yield* fixture.build({ pageSize: 1, maxPages: 1 })
    expect(yield* small.sync(captureAddress)).toEqual({ sources: 0, through: 0, hasMore: true, stalled: "open-turn" })
    const open = yield* fixture.build({ pageSize: 10 })
    expect(yield* open.sync(captureAddress)).toEqual({ sources: 0, through: 0, hasMore: true, stalled: "open-turn" })
    yield* closeCaptureTurn(writer)
    expect(yield* small.sync(captureAddress)).toEqual({ sources: 0, through: 0, hasMore: true, stalled: "page-limit" })
    const enough = yield* fixture.build({ pageSize: 1, maxPages: 10, maxTurns: 1 })
    const completed = yield* enough.sync(captureAddress)
    expect(completed).toMatchObject({ sources: 1, hasMore: false })
    expect(completed.through).toBeGreaterThan(0)
  }))))

  test("a full page ending at a captured turn still reports later unseen work", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions, RunId.make("capture-second")))
    const capture = yield* fixture.build({ pageSize: 1, maxTurns: 1 })
    expect((yield* capture.sync(captureAddress)).hasMore).toBe(true)
    expect((yield* capture.sync(captureAddress)).hasMore).toBe(false)
  }))))

  test("lost checkpoint acknowledgements replay idempotently and concurrent syncs keep monotonic checkpoints", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const lost = Sessions.of({ ...fixture.sessions, transact: () => Effect.fail(new SessionLogError({ code: "store.io", message: "Fixture checkpoint ACK lost" })) })
    const first = yield* fixture.build({}, lost)
    expect((yield* Effect.result(first.sync(captureAddress)))._tag).toBe("Failure")
    const resumed = yield* fixture.build()
    const synced = yield* Effect.all([resumed.sync(captureAddress), resumed.sync(captureAddress)], { concurrency: 2 })
    expect(synced.every((result) => result.hasMore === false)).toBe(true)
    const jobs = yield* fixture.store.pending({ engine: "memory:1", namespace: "default", now: 10_000_000_000_000, limit: 100 })
    expect(jobs).toHaveLength(1)
    expect((yield* resumed.sync(captureAddress)).sources).toBe(0)
    const scopes = (yield* Ref.get(fixture.calls)).map((input) => input.source)
    expect(scopes.every((source) => JSON.stringify(source) === JSON.stringify(scopes[0]))).toBe(true)
  }))))

  test("forgotten sources are not resurrected after a capture/ACK race", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const lost = Sessions.of({ ...fixture.sessions, transact: () => Effect.fail(new SessionLogError({ code: "store.io", message: "Fixture checkpoint ACK lost" })) })
    yield* Effect.result((yield* fixture.build({}, lost)).sync(captureAddress))
    const source = (yield* Ref.get(fixture.calls))[0]!.source
    yield* fixture.store.forget(source.scope, source.ref.id, 100)
    const capture = yield* fixture.build()
    expect((yield* capture.sync(captureAddress)).hasMore).toBe(false)
    expect(yield* fixture.store.source(source.scope, source.ref)).toEqual(Option.none())
    expect((yield* fixture.store.pending({ engine: "memory:1", namespace: "default", now: 1000, limit: 100 }))).toEqual([])
  }))))

  test("backfill paginates owner sessions and never reads another owner's records", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const second = { owner: captureAddress.owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000e2") }
    const other = { owner: "other-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000e3") }
    yield* fixture.sessions.create(second)
    yield* fixture.sessions.create(other)
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions, RunId.make("second-owner-session"), second))
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions, RunId.make("other-owner-session"), other))
    const capture = yield* fixture.build()
    const first = yield* capture.backfill({ owner: captureAddress.owner, limit: 1 })
    expect(first.sources).toBe(1)
    expect(Option.isSome(first.next)).toBe(true)
    const remaining = yield* capture.backfill({ owner: captureAddress.owner, before: Option.getOrElse(first.next, () => ({ updatedAt: 0, id: captureAddress.id })), limit: 10 })
    expect(remaining.sources).toBe(1)
    expect((yield* Ref.get(fixture.calls)).every((input) => input.source.scope.owner === captureAddress.owner)).toBe(true)
    expect((yield* Effect.result(capture.sync({ ...captureAddress, owner: "other-owner" })))._tag).toBe("Failure")
  }))))

  test("an ACK committed before its acknowledgement was lost is respected on retry", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const lost = Sessions.of({ ...fixture.sessions, transact: (address, decide) => fixture.sessions.transact(address, decide).pipe(Effect.andThen(Effect.fail(new SessionLogError({ code: "store.io", message: "Fixture ACK committed before lost acknowledgement" })))) })
    expect((yield* Effect.result((yield* fixture.build({}, lost)).sync(captureAddress)))._tag).toBe("Failure")
    expect((yield* Ref.get(fixture.calls))).toHaveLength(1)
    expect((yield* (yield* fixture.build()).sync(captureAddress)).sources).toBe(0)
    expect((yield* Ref.get(fixture.calls))).toHaveLength(1)
  }))))

  test("a malformed or forward checkpoint fails rather than skipping source evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    const writer = yield* openCaptureTurn(fixture.sessions)
    yield* writer.append([{ kind: "@xandreed/plugin-memory/capture.ack", data: { namespace: "default", collection: "memory", version: "1", through: 999 } }])
    yield* closeCaptureTurn(writer)
    const synced = yield* Effect.result((yield* fixture.build()).sync(captureAddress))
    expect(synced._tag === "Failure" && synced.failure.reason).toBe("Corrupt")
    expect(yield* Ref.get(fixture.calls)).toEqual([])
  }))))

  test("legacy failed tool evidence keeps unavailable correlation explicit", () => {
    const entry = capturedEntry(1, { _tag: "ToolResult", toolCallId: ToolCallId.make("legacy"), toolName: "deliver", isError: true, encoded: { error: "Failed" }, view: "Delivery failed.", viewVersion: "1", subjects: [], artifacts: [], pinned: false }, 7)
    expect(capturedTurnText([entry], [{ invocationId: InvocationId.make("legacy:call:1"), tool: "deliver", step: 7, ok: false }])).toBe('Tool result: deliver\nPairing key: "legacy"\nStep: 7\nLoop run: unavailable\nRecorded outcome: reported failure\nArguments: {}\nRecorded result: Delivery failed.\n\nTool handler receipt: deliver\nInvocation: legacy:call:1\nPairing key: unavailable\nStep: 7\nHandler outcome: reported failure\nA handler receipt alone does not confirm a real-world effect; inspect the recorded domain result.')
  })

  test("fork synchronization captures only local journal rows and never recounts inherited episodes", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const capture = yield* fixture.build()
    expect((yield* capture.sync(captureAddress)).sources).toBe(1)
    const forks = yield* Effect.forEach([4, 5, 6], (suffix) => fixture.sessions.fork(captureAddress, { id: ConversationId.make(`00000000-0000-4000-8000-0000000000e${suffix}`), origin: "fixture-fork", inherit: true }), { concurrency: 1 })
    yield* Effect.forEach(forks, (fork) => Effect.gen(function* () {
      const address = { owner: captureAddress.owner, id: fork.header.id }
      expect(yield* fixture.sessions.read(address)).toEqual([])
      expect(yield* capture.sync(address)).toEqual({ sources: 0, through: 0, hasMore: false })
    }), { concurrency: 1 })
    expect((yield* Ref.get(fixture.calls))).toHaveLength(1)
    const first = forks[0]!
    const child = { owner: captureAddress.owner, id: first.header.id }
    const writer = yield* openCaptureTurn(fixture.sessions, RunId.make("fork-local-turn"), child)
    const inherited = yield* writer.history(["turn.started", "turn.ended"])
    expect(inherited.length).toBeGreaterThan(0)
    expect(inherited.every((row) => row.session === captureAddress.id)).toBe(true)
    yield* closeCaptureTurn(writer, "A new local reply.")
    expect((yield* capture.sync(child)).sources).toBe(1)
    expect((yield* capture.sync(captureAddress)).sources).toBe(0)
    const sources = (yield* Ref.get(fixture.calls)).map((input) => input.source)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.metadata.episode).toBe(`conversation:${captureAddress.id}:${captureRun}`)
    expect(sources[1]!.metadata.episode).toBe(`conversation:${child.id}:fork-local-turn`)
  }))))

  test("a refused turn enqueues nothing, and the checkpoint moves past it so no later sync reads it again", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    const kept = RunId.make("capture-kept")
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions), "Withheld reply.")
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions, kept), "Kept reply.")
    const seen = yield* admissionLog
    const capture = yield* fixture.build()
    const synced = yield* capture.sync(captureAddress).pipe(admittingWith(seen, (turn) => Effect.succeed(turn.runId === captureRun ? { _tag: "Refuse" } : { _tag: "Admit" })))
    expect(synced).toMatchObject({ sources: 1, hasMore: false, refused: [1] })
    // The admission is asked once per committed turn, with the evidence capture would store.
    const asked = yield* Ref.get(seen)
    expect(asked.map((turn) => [turn.session, turn.runId, turn.turn])).toEqual([[captureAddress, captureRun, 1], [captureAddress, kept, 2]])
    expect(asked.map((turn) => turn.text)).toEqual([
      "User: Please update the record.\n\nAssistant final reply: Withheld reply.",
      "User: Please update the record.\n\nAssistant final reply: Kept reply.",
    ])
    expect(asked.every((turn) => turn.entries.some((entry) => entry.body._tag === "TurnEnded"))).toBe(true)
    expect(asked[0]!.text).toBe(capturedTurnText(asked[0]!.entries))
    const sources = (yield* Ref.get(fixture.calls)).map((input) => input.source)
    expect(sources.map((source) => source.text)).toEqual(["User: Please update the record.\n\nAssistant final reply: Kept reply."])
    expect(sources[0]!.metadata.run).toBe(kept)
    // Admitting everything afterwards finds nothing left to read: the refused turn is behind the checkpoint.
    expect(yield* capture.sync(captureAddress)).toEqual({ sources: 0, through: synced.through, hasMore: false })
    expect(yield* Ref.get(fixture.calls)).toHaveLength(1)
  }))))

  test("a refused last turn still moves the checkpoint, and backfill counts refused turns", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const seen = yield* admissionLog
    const capture = yield* fixture.build()
    const refuse = admittingWith(seen, () => Effect.succeed({ _tag: "Refuse" }))
    const backfilled = yield* capture.backfill({ owner: captureAddress.owner }).pipe(refuse)
    expect(backfilled).toEqual({ sources: 0, next: Option.none(), refused: 1 })
    expect(yield* Ref.get(fixture.calls)).toEqual([])
    const acks = yield* fixture.sessions.read(captureAddress, { kinds: ["@xandreed/plugin-memory/capture.ack"] })
    expect(acks).toHaveLength(1)
    expect((yield* capture.sync(captureAddress)).sources).toBe(0)
    expect(yield* Ref.get(seen)).toHaveLength(1)
  }))))

  test("an admitted replacement is the evidence enqueued, split and measured as the source", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions), "Reply with a detail to withhold.")
    const seen = yield* admissionLog
    const replacement = "User: Please update the record.\n\nAssistant final reply: [withheld]"
    const capture = yield* fixture.build({ maxSourceChars: 40 })
    const synced = yield* capture.sync(captureAddress).pipe(admittingWith(seen, () => Effect.succeed({ _tag: "Admit", text: replacement })))
    const sources = (yield* Ref.get(fixture.calls)).map((input) => input.source)
    expect(synced.sources).toBe(sources.length)
    expect(synced.refused).toBeUndefined()
    expect(sources.map((source) => source.text).join("")).toBe(replacement)
    expect(sources.every((source) => source.metadata.totalChars === replacement.length)).toBe(true)
    expect(sources.some((source) => source.text.includes("withhold."))).toBe(false)
  }))))

  test("a failing or invalid admission fails the sync without moving the checkpoint past the turn", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeCaptureFixture
    yield* closeCaptureTurn(yield* openCaptureTurn(fixture.sessions))
    const seen = yield* admissionLog
    const capture = yield* fixture.build()
    const failed = yield* Effect.result(capture.sync(captureAddress).pipe(admittingWith(seen, () => Effect.fail(new KnowledgeError({ reason: "Unavailable", message: "The host's screening service is unavailable" })))))
    expect(failed._tag === "Failure" && failed.failure.reason).toBe("Unavailable")
    const invalid = yield* Effect.result(capture.sync(captureAddress).pipe(admittingWith(seen, () => Effect.succeed({ _tag: "Admit", text: "" }))))
    expect(invalid._tag === "Failure" && invalid.failure.reason).toBe("Invalid")
    expect(yield* Ref.get(fixture.calls)).toEqual([])
    expect(yield* fixture.sessions.read(captureAddress, { kinds: ["@xandreed/plugin-memory/capture.ack"] })).toEqual([])
    // The turn is asked again on the next sync, and the default admission captures it as is.
    expect((yield* capture.sync(captureAddress)).sources).toBe(1)
    expect(yield* Ref.get(seen)).toHaveLength(2)
  }))))
})
