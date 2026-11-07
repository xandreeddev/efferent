import { Context, Effect, Layer, Option, Ref } from "effect"
import {
  ConversationId, EntryId, LongTermMemory, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage,
  draftsOfEntries, frameworkDraft, makeKnowledgeIndexMemory,
} from "@xandreed/core"
import type { KnowledgeEnqueue, KnowledgeError, KnowledgeIndex, LogBody, LogEntry, TurnWriter } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { MemoryCaptureLive } from "./memory-capture.adapter.js"
import { memoryCaptureDefaults } from "./memory.entity.js"
import type { MemoryCaptureConfig, MemoryCaptureDecision, MemoryCaptureTurn } from "./memory.entity.js"
import { MemoryCapture, MemoryCaptureAdmission } from "./ports/memory-capture.port.js"

export const captureAddress = { owner: "capture-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000e1") }
export const captureRun = RunId.make("capture-fixture")
export const capturedEntry = (index: number, body: LogBody, step = 0, runId = captureRun, turn = 1): LogEntry => ({ id: EntryId.make(`${runId}:${index}`), runId, turn, step, at: index + 10, body })
export const appendCapturedEntries = (writer: TurnWriter, entries: ReadonlyArray<LogEntry>) => draftsOfEntries(entries).pipe(Effect.orDie, Effect.flatMap((drafts) => writer.append(drafts.map((draft) => frameworkDraft(draft.kind, draft.data)))))
export const openCaptureTurn = (sessions: typeof Sessions.Service, runId = captureRun, address = captureAddress) => sessions.begin(address, { _tag: "User", runId, key: runId, command: {}, userMessage: new UserMessage({ text: "Please update the record." }) })
export const closeCaptureTurn = (writer: TurnWriter, reply = "Done.") => draftsOfEntries([capturedEntry(900, { _tag: "TurnEnded", outcome: "completed", reply: Option.some(reply) }, 0, writer.admitted.runId, writer.admitted.turn)]).pipe(
  Effect.orDie, Effect.flatMap((drafts) => writer.closing(drafts.map((draft) => frameworkDraft(draft.kind, draft.data)))),
  Effect.andThen(writer.end({ reason: "completed", failure: Option.none() })),
)
export const captureMemory = (store: KnowledgeIndex, calls: Ref.Ref<ReadonlyArray<KnowledgeEnqueue>>): typeof LongTermMemory.Service => LongTermMemory.of({
  capture: (input) => Ref.update(calls, (all) => [...all, input]).pipe(Effect.andThen(store.enqueue(input))),
  process: () => Effect.succeed(0), recall: () => Effect.succeed({ candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] }),
  profile: () => Effect.succeed([]), source: store.source, status: store.status, retry: store.retry, forget: (scope, id) => store.forget(scope, id, 100),
})
export const makeCaptureFixture = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: captureAddress.owner, id: captureAddress.id })
  const store = yield* makeKnowledgeIndexMemory()
  const calls = yield* Ref.make<ReadonlyArray<KnowledgeEnqueue>>([])
  const memory = captureMemory(store, calls)
  const build = (options: Partial<MemoryCaptureConfig> = {}, ownSessions = sessions, ownMemory = memory) => Layer.build(MemoryCaptureLive({ ...memoryCaptureDefaults, ...options }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(Sessions, ownSessions), Layer.succeed(LongTermMemory, ownMemory))),
  )).pipe(Effect.map((context) => Context.get(context, MemoryCapture)))
  return { sessions, store, calls, memory, build }
})
/** The turns an admission was asked about, in order. */
export const admissionLog = Ref.make<ReadonlyArray<MemoryCaptureTurn>>([])
/** Run `effect` with `decide` as the capture admission, recording every turn it is asked about. */
export const admittingWith = (seen: Ref.Ref<ReadonlyArray<MemoryCaptureTurn>>, decide: (turn: MemoryCaptureTurn) => Effect.Effect<MemoryCaptureDecision, KnowledgeError>) =>
  Effect.provideService(MemoryCaptureAdmission, { admit: (turn) => Ref.update(seen, (all) => [...all, turn]).pipe(Effect.andThen(decide(turn))) })
