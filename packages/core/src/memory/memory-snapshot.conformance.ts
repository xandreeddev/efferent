import { Effect, Option } from "effect"
import { check, expect } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { MediaFingerprint } from "../domain/media.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { EntryId } from "./memory-log.entity.js"
import type { LogBody, LogEntry } from "./memory-log.entity.js"
import { buildContext, canonicalJson, entriesSendingMedia } from "./memory-log.entity.functions.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import { prepareMemorySnapshot, projectMemorySnapshot, validateMemorySnapshot } from "./memory-snapshot.entity.functions.js"
import { MemoryStrategyId } from "./memory-snapshot.entity.js"
import type { MemorySnapshotCandidate } from "./memory-snapshot.entity.js"

/** Pure selection, authoritative-prefix validation and guarded projection. @public */
export interface MemorySnapshotSubject {
  readonly prepare: typeof prepareMemorySnapshot
  readonly validate: typeof validateMemorySnapshot
  readonly project: typeof projectMemorySnapshot
}

const strategy = { id: MemoryStrategyId.make("summary"), version: "2" }
const e = (index: number, turn: number, body: LogBody, step = 0): LogEntry => ({ id: EntryId.make(`r${turn}:${index}`), runId: RunId.make(`r${turn}`), turn, step, at: 0, body })
const call = (id: string) => ({ type: "tool-call" as const, toolCallId: ToolCallId.make(id), toolName: "lookup", input: { q: id } })
const result = (id: string, pinned: boolean, run: number): Extract<LogBody, { readonly _tag: "ToolResult" }> => ({
  _tag: "ToolResult", run: RunOrdinal.make(run), toolCallId: call(id).toolCallId, toolName: "lookup", isError: false,
  encoded: { value: `${id} ${"opaque ".repeat(80)}` }, view: `raw ${id}`, viewVersion: "raw", subjects: [], artifacts: [], pinned,
})
const image = {
  type: "media" as const, mediaType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  fingerprint: MediaFingerprint.make("44b70f79e64f7e1446"), bytes: 70, name: "checkpoint.png", alt: "a checkpoint",
}

/** Fixed interleaved exchanges and raw overlay facts shared by kit and its property checks. */
export const memorySnapshotFixture = (): ReadonlyArray<LogEntry> => [
  e(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "old user" }) }),
  e(1, 1, { _tag: "StepContext", step: 0, run: RunOrdinal.make(0), text: "OLD ZERO" }),
  e(2, 1, { _tag: "StepContext", step: 0, run: RunOrdinal.make(1), text: "OLD ONE" }),
  e(3, 1, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [{ type: "reasoning", text: "signed", providerOptions: { custom: { signature: "Ω exact" } } }, call("a"), call("x")] } }),
  e(4, 1, { _tag: "Message", run: RunOrdinal.make(1), message: { role: "assistant", content: [call("b")] } }),
  e(5, 1, result("b", true, 1)),
  e(6, 1, result("a", false, 0)),
  e(7, 1, result("x", false, 0)),
  e(8, 1, { _tag: "ToolPresentation", entry: EntryId.make("r1:6"), view: "presented a", viewVersion: "1", subjects: [], artifacts: [], pinned: true, media: [], mediaNotes: [] }),
  e(9, 1, { _tag: "ToolDigest", entry: EntryId.make("r1:6"), version: "1", mode: "summarize", keep: [], text: "digested a", digester: "fixture@1", trigger: "compaction" }),
  e(10, 1, { _tag: "Compaction", strategy: "summary", version: "2", action: { _tag: "CompactViews", entries: [EntryId.make("r1:5")], texts: ["compact b"] } }),
  e(11, 1, { _tag: "Compaction", strategy: "summary", version: "2", action: { _tag: "Spill", entry: EntryId.make("r1:5"), preview: "spill b" } }),
  e(12, 1, { _tag: "Compaction", strategy: "other", version: "1", action: { _tag: "OmitMedia", entries: [EntryId.make("r1:5")], reason: "refused" } }),
  e(13, 1, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [call("late")] } }, 2),
  e(0, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "current", attachments: [image] }) }),
  e(1, 2, { _tag: "Message", inbox: InboxItemId.make("steer"), run: RunOrdinal.make(0), message: { role: "user", content: [{ type: "text", text: "steer" }, image] } }),
  e(2, 2, { _tag: "StepContext", step: 0, run: RunOrdinal.make(0), text: "CURRENT ZERO" }),
  e(3, 2, { _tag: "StepContext", step: 0, run: RunOrdinal.make(1), text: "CURRENT ONE" }),
  e(4, 2, { _tag: "Compaction", strategy: "summary", version: "2", action: { _tag: "Summarize", keepFromTurn: 2, summary: "Earlier checkpoint." } }),
  e(5, 2, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [call("a")] } }, 1),
  e(6, 2, result("a", false, 0), 1),
  e(7, 2, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("complete") }),
]

/** Supported option family, including old run contexts whose latest step text must survive. */
export const memorySnapshotOptions = (): ReadonlyArray<RenderOptions> => ["current", "all"].flatMap((turnContext) => [false, true].flatMap((replies) =>
  [false, true].flatMap((digests) => ["none", "tail"].flatMap((stepContext) => [
    { mode: "none" as const, maxImages: 0, maxChars: 0 }, { mode: "inline" as const, maxImages: 1, maxChars: 100 }, { mode: "inline" as const, maxImages: 8, maxChars: 20_000_000 },
  ].flatMap((media) => [1, 2].flatMap((turn) => [0, 1].map((run) => ({
    strategy: "summary", currentTurn: 2, currentRun: RunId.make(`r${turn}`), run: RunOrdinal.make(run),
    turnContext: turnContext as "current" | "all", replies, digests, stepContext: stepContext as "none" | "tail", media,
  }))))))))

const basic = (): RenderOptions => memorySnapshotOptions()[0]!
const same = (full: ReadonlyArray<LogEntry>, projected: ReadonlyArray<LogEntry>, options: RenderOptions) =>
  canonicalJson(buildContext(full, options)) === canonicalJson(buildContext(projected, options)) && canonicalJson(entriesSendingMedia(full, options)) === canonicalJson(entriesSendingMedia(projected, options))
const candidate = (subject: MemorySnapshotSubject, entries = memorySnapshotFixture()) => subject.prepare(entries, strategy).pipe(Effect.flatMap((found) => {
  if (Option.isSome(found)) return Effect.succeed(found.value)
  return Effect.fail(new Error("a reducing summary did not prepare a snapshot"))
}))

/** Raw retention, validation and safe fallback without changing archive-reader semantics. @public */
export const memorySnapshotConformance = (subject: MemorySnapshotSubject = { prepare: prepareMemorySnapshot, validate: validateMemorySnapshot, project: projectMemorySnapshot }): ReadonlyArray<ConformanceCheck> => [
  check("a reducing prefix preserves raw dependencies in original order", "selection", () => Effect.gen(function* () {
    const full = memorySnapshotFixture()
    const saved = yield* candidate(subject, full)
    yield* expect("selection", saved.anchor === "r2:0" && saved.through === "r2:7", "anchor/frontier are not actual memory IDs")
    const ids = saved.entries.map((entry) => entry.id)
    yield* expect("selection", ["r1:3", "r1:4", "r1:5", "r1:6", "r1:8", "r1:9", "r1:10", "r1:11", "r1:12", "r1:1", "r1:2"].every((id) => ids.some((entry) => entry === id)) && !ids.some((id) => id === "r1:7"), "pinned results, hidden requests or raw metadata were lost")
    yield* expect("selection", saved.entries.map((entry) => entry.id).join() === full.filter((entry) => ids.includes(entry.id)).map((entry) => entry.id).join(), "raw entries were regrouped")
    const raw = saved.entries.find((entry) => entry.id === "r1:6")
    yield* expect("selection", raw?.body._tag === "ToolResult" && !raw.body.pinned && raw.body.view === "raw a", "a presentation was flattened over the raw result")
  })),
  check("selected malformed snapshots fail as session.decode", "integrity", () => Effect.gen(function* () {
    const full = memorySnapshotFixture()
    const saved = yield* candidate(subject, full)
    const altered: ReadonlyArray<MemorySnapshotCandidate> = [
      { ...saved, entries: saved.entries.slice(1) }, { ...saved, entries: [...saved.entries, saved.entries[0]!] },
      { ...saved, entries: [...saved.entries].reverse() }, { ...saved, anchor: EntryId.make("missing") },
      { ...saved, entries: saved.entries.map((entry) => entry.id === "r1:6" ? { ...entry, at: 42 } : entry) },
    ]
    yield* Effect.forEach(altered, (value) => subject.validate(full, value, strategy, basic()).pipe(Effect.result, Effect.flatMap((result) =>
      expect("integrity", result._tag === "Failure" && result.failure.code === "session.decode", "corrupt snapshot was accepted or silently fell back"))), { concurrency: 1 })
  })),
  check("all supported render options preserve complete build and media metadata", "options", () => Effect.gen(function* () {
    const full = memorySnapshotFixture(), saved = yield* candidate(subject, full)
    const phase = yield* subject.validate(full, saved, strategy, basic())
    yield* expect("options", phase._tag === "Projected", "valid snapshot was not selected")
    yield* Effect.forEach(memorySnapshotOptions(), (options) => {
      const built = subject.project(full, phase, options)
      return expect("options", built.phase._tag === "Projected" && built.entries.length < full.length && same(full, built.entries, options), "projection changed request bytes/metadata or bypassed reuse")
    }, { concurrency: 1 })
  })),
  check("new old-entry dependencies use the full archive", "fallback", () => Effect.gen(function* () {
    const full = memorySnapshotFixture(), saved = yield* candidate(subject, full)
    const phase = yield* subject.validate(full, saved, strategy, basic())
    const late = e(8, 2, { _tag: "ToolPresentation", entry: EntryId.make("r1:7"), view: "late pin", viewVersion: "2", subjects: [], artifacts: [], pinned: true, media: [], mediaNotes: [] })
    const additions: ReadonlyArray<LogEntry> = [late,
      e(9, 2, { _tag: "ToolDigest", entry: EntryId.make("r1:7"), version: "1", mode: "summarize", keep: [], text: "late digest", digester: "fixture@1", trigger: "compaction" }),
      e(14, 1, result("late", true, 0), 2),
    ]
    yield* Effect.forEach(additions, (addition) => {
      const appended = [...full, addition], result = subject.project(appended, phase, basic())
      return expect("fallback", result.phase._tag === "Full" && same(appended, result.entries, basic()), "a late overlay or newly needed request was ignored")
    }, { concurrency: 1 })
  })),
  check("valid other strategies and incompatible render requests use full history", "compatibility", () => Effect.gen(function* () {
    const full = memorySnapshotFixture(), saved = yield* candidate(subject, full)
    const other = yield* subject.validate(full, saved, { ...strategy, version: "3" }, basic())
    yield* expect("compatibility", other._tag === "Full", "a different strategy version reused the snapshot")
    const phase = yield* subject.validate(full, saved, strategy, basic())
    const options = { ...basic(), strategy: "other" }
    const result = subject.project(full, phase, options)
    yield* expect("compatibility", result.phase._tag === "Full" && same(full, result.entries, options), "a different renderer strategy reused the snapshot")
  })),
]
