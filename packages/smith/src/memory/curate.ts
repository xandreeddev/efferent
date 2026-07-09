import { Array as Arr, Effect, Option, Schema } from "effect"
import type { FactoryRun } from "@xandreed/foundry"
import { ConversationId, ConversationStore, UtilityLlm } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { renderTrailForDigest } from "../implementor/efferentImplementor.js"
import {
  CorroborateMemory,
  CreateMemory,
  foldMemory,
  InvalidateMemory,
  MemoryId,
  MemoryProvenance,
  MemoryTopic,
  UpdateMemory,
} from "./domain.js"
import type { MemoryEvent, MemoryRecord } from "./domain.js"
import { appendMemoryEvents, memoryLedgerPath, readMemoryLedger } from "./ledger.js"

/**
 * The curator: after a forge run, two fast-tier calls turn the implementor's
 * trail into ledger verbs — EXTRACT (topic-scoped signal, never narration)
 * then CONSOLIDATE (compare candidates against the existing actives; emit
 * create/corroborate/update/invalidate). Deterministic guards do the actual
 * enforcement: statement caps, create caps, active-set cap, index-referenced
 * ids (the model never mints or repeats an id — hallucination guard).
 * BEST-EFFORT by construction: undecodable JSON, a slow tier, or a store
 * failure writes nothing and never fails the run.
 */

const STATEMENT_CAP_CHARS = 300
const MAX_CREATES_PER_RUN = 5
const MAX_ACTIVE_RECORDS = 50
const MIN_TRAIL_CHARS = 2_000
const CURATE_TIMEOUT_MS = 45_000

const CandidateFact = Schema.Struct({ topic: MemoryTopic, statement: Schema.String })
type CandidateFact = typeof CandidateFact.Type
const ExtractOutput = Schema.parseJson(Schema.Array(CandidateFact))

const VerbOut = Schema.Union(
  Schema.Struct({ op: Schema.Literal("create"), candidate: Schema.Number }),
  Schema.Struct({ op: Schema.Literal("corroborate"), memory: Schema.Number }),
  Schema.Struct({
    op: Schema.Literal("update"),
    memory: Schema.Number,
    statement: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("invalidate"),
    memory: Schema.Number,
    reason: Schema.String,
  }),
)
const ConsolidateOutput = Schema.parseJson(Schema.Array(VerbOut))

/** Models fence JSON; the parse must not care. */
const stripFences = (text: string): string => {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced?.[1] ?? trimmed
}

export const extractPrompt = (transcript: string): string => `You are curating a coding workspace's long-term memory from one agent session's transcript. Extract ONLY durable, reusable workspace facts — the things a future session would otherwise rediscover the hard way.

Topics (the ONLY four):
- "convention": a naming/structure/style rule this workspace follows.
- "build-quirk": a non-obvious build, tooling, or test behavior of THIS workspace.
- "dependency": a version or API peculiarity of a dependency as used here.
- "gotcha": a trap that cost the session time and WOULD recur.

Do NOT extract: session narration, task-specific state, opinions, anything a test failure report already states, or generic language knowledge.

Reply with ONLY a JSON array (no prose): [{"topic": "...", "statement": "..."}] — at most 5 items, each statement one sentence under 300 characters, specific enough to act on. An empty array [] is the correct answer when nothing qualifies.

TRANSCRIPT:
${transcript}`

export const consolidatePrompt = (
  actives: ReadonlyArray<MemoryRecord>,
  candidates: ReadonlyArray<CandidateFact>,
): string => `You are consolidating a coding workspace's memory. Compare the NEW candidate facts against the EXISTING memories and emit operations.

EXISTING memories:
${actives.map((record, index) => `M${index + 1} [${record.topic}]: ${record.statement}`).join("\n")}

NEW candidates:
${candidates.map((candidate, index) => `C${index + 1} [${candidate.topic}]: ${candidate.statement}`).join("\n")}

Operations (reply with ONLY a JSON array, no prose):
- {"op": "create", "candidate": <n>} — the candidate is genuinely NEW.
- {"op": "corroborate", "memory": <n>} — a candidate re-states an existing memory (same fact, any wording).
- {"op": "update", "memory": <n>, "statement": "..."} — new information CORRECTS or sharpens an existing memory; write the merged statement (one sentence, under 300 chars).
- {"op": "invalidate", "memory": <n>, "reason": "..."} — the transcript shows an existing memory is now WRONG.

Every candidate maps to exactly one create/corroborate/update; never create a duplicate of an existing memory. [] is valid when nothing changes.`

interface Tally {
  readonly events: ReadonlyArray<MemoryEvent>
  readonly created: number
  readonly updated: number
  readonly corroborated: number
  readonly invalidated: number
}

const emptyTally: Tally = { events: [], created: 0, updated: 0, corroborated: 0, invalidated: 0 }

/** Verbs → ledger events, deterministically guarded: unknown indexes drop,
 *  statements clip, creates cap, the active set stays bounded. */
export const resolveVerbs = (
  verbs: ReadonlyArray<typeof VerbOut.Type>,
  actives: ReadonlyArray<MemoryRecord>,
  candidates: ReadonlyArray<CandidateFact>,
  provenance: MemoryProvenance,
): Tally =>
  verbs.reduce((tally: Tally, verb) => {
    if (verb.op === "create") {
      const candidate = candidates[verb.candidate - 1]
      if (candidate === undefined) return tally
      if (tally.created >= MAX_CREATES_PER_RUN) return tally
      if (actives.length + tally.created >= MAX_ACTIVE_RECORDS) return tally
      return {
        ...tally,
        created: tally.created + 1,
        events: [
          ...tally.events,
          CreateMemory.make({
            id: MemoryId.make(crypto.randomUUID()),
            topic: candidate.topic,
            statement: candidate.statement.slice(0, STATEMENT_CAP_CHARS),
            provenance,
          }),
        ],
      }
    }
    const target = actives[verb.memory - 1]
    if (target === undefined) return tally
    if (verb.op === "corroborate") {
      return {
        ...tally,
        corroborated: tally.corroborated + 1,
        events: [...tally.events, CorroborateMemory.make({ id: target.id, provenance })],
      }
    }
    if (verb.op === "update") {
      return {
        ...tally,
        updated: tally.updated + 1,
        events: [
          ...tally.events,
          UpdateMemory.make({
            id: target.id,
            statement: verb.statement.slice(0, STATEMENT_CAP_CHARS),
            provenance,
          }),
        ],
      }
    }
    return {
      ...tally,
      invalidated: tally.invalidated + 1,
      events: [
        ...tally.events,
        InvalidateMemory.make({
          id: target.id,
          reason: verb.reason.slice(0, STATEMENT_CAP_CHARS),
          provenance,
        }),
      ],
    }
  }, emptyTally)

/**
 * The post-forge curation pass. Runs synchronously after the run (a CLI has
 * no daemon — a forked fiber racing process exit is a lost write), bounded
 * by a hard timeout, and silent on every failure path.
 */
export const curateWorkspaceMemory = (options: {
  readonly cwd: string
  readonly run: FactoryRun
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
}): Effect.Effect<void, never, UtilityLlm | ConversationStore> =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const utility = yield* UtilityLlm

    const conversationId = Arr.findFirst(options.run.attempts, (attempt) =>
      Option.isSome(attempt.implementorRef),
    ).pipe(
      Option.flatMap((attempt) => attempt.implementorRef),
      Option.flatMap((ref) =>
        ref.startsWith("conversation:")
          ? Schema.decodeOption(ConversationId)(ref.slice("conversation:".length))
          : Option.none(),
      ),
    )
    if (Option.isNone(conversationId)) return

    const trail = yield* store.list(conversationId.value)
    const transcript = renderTrailForDigest(trail)
    // A trivial trail teaches nothing worth a paid call.
    if (transcript.length < MIN_TRAIL_CHARS) return

    const path = memoryLedgerPath(options.cwd)
    const actives = foldMemory(yield* readMemoryLedger(path))

    const extracted = yield* utility.complete(extractPrompt(transcript))
    const candidates = (yield* Schema.decodeUnknown(ExtractOutput)(
      stripFences(extracted.text),
    )).slice(0, MAX_CREATES_PER_RUN)
    if (candidates.length === 0) return

    const provenance = new MemoryProvenance({
      runId: String(options.run.id),
      at: new Date().toISOString(),
    })

    // No existing memory → every candidate is a create; otherwise the model
    // consolidates and the verbs resolve under the deterministic guards.
    const verbs =
      actives.length === 0
        ? candidates.map((_, index) => ({ op: "create" as const, candidate: index + 1 }))
        : yield* utility
            .complete(consolidatePrompt(actives, candidates))
            .pipe(
              Effect.flatMap((response) =>
                Schema.decodeUnknown(ConsolidateOutput)(stripFences(response.text)),
              ),
            )

    const tally = resolveVerbs(verbs, actives, candidates, provenance)
    if (tally.events.length === 0) return
    yield* appendMemoryEvents(path, tally.events)
    yield* options.publish({
      type: "memory_updated",
      created: tally.created,
      updated: tally.updated,
      corroborated: tally.corroborated,
      invalidated: tally.invalidated,
    })
  }).pipe(
    Effect.timeout(CURATE_TIMEOUT_MS),
    Effect.withSpan("smith.memory"),
    Effect.catchAll(() => Effect.void),
  )
