import { Match, Option, Schema } from "effect"

/**
 * Memory v2 — the LLM-curated workspace memory. The deterministic lessons
 * (foundry's gate-evidence fold) stay untouched; THIS store carries what the
 * artifacts cannot derive: conventions discovered while coding, build
 * quirks, dependency facts, gotchas. The consolidation verbs ARE the ledger
 * rows (append-only, git-diffable provenance); the injected view is a pure
 * fold. No row is ever edited — an invalidation is a new row.
 */

export const MemoryId = Schema.String.pipe(Schema.brand("MemoryId"))
export type MemoryId = typeof MemoryId.Type

export const MemoryTopic = Schema.Literal("convention", "build-quirk", "dependency", "gotcha")
export type MemoryTopic = typeof MemoryTopic.Type

export class MemoryProvenance extends Schema.Class<MemoryProvenance>("MemoryProvenance")({
  /** The forge run this event came out of. */
  runId: Schema.String,
  /** ISO timestamp. */
  at: Schema.String,
}) {}

/** The consolidation verbs, one JSONL row each. `corroborate` is the
 *  MERGE-of-an-equal-fact case; `update` is defer-to-newer correction. */
export const CreateMemory = Schema.TaggedStruct("create", {
  id: MemoryId,
  topic: MemoryTopic,
  statement: Schema.String,
  provenance: MemoryProvenance,
})
export const UpdateMemory = Schema.TaggedStruct("update", {
  id: MemoryId,
  statement: Schema.String,
  provenance: MemoryProvenance,
})
export const CorroborateMemory = Schema.TaggedStruct("corroborate", {
  id: MemoryId,
  provenance: MemoryProvenance,
})
export const InvalidateMemory = Schema.TaggedStruct("invalidate", {
  id: MemoryId,
  reason: Schema.String,
  provenance: MemoryProvenance,
})
export const MemoryEvent = Schema.Union(
  CreateMemory,
  UpdateMemory,
  CorroborateMemory,
  InvalidateMemory,
)
export type MemoryEvent = typeof MemoryEvent.Type

/** One ACTIVE memory — the fold's output, never persisted directly. */
export class MemoryRecord extends Schema.Class<MemoryRecord>("MemoryRecord")({
  id: MemoryId,
  topic: MemoryTopic,
  statement: Schema.String,
  /** Times independent runs re-observed this fact — the trust signal. */
  corroboration: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The last few contributing run ids (bounded). */
  sources: Schema.Array(Schema.String),
}) {}

const MAX_SOURCES = 5

const withSource = (
  sources: ReadonlyArray<string>,
  runId: string,
): ReadonlyArray<string> =>
  sources.includes(runId) ? sources : [...sources, runId].slice(-MAX_SOURCES)

/**
 * Events → the active set (insertion-ordered). Verbs referencing an unknown
 * id are inert — a create dropped by a cap must not brick later rows.
 * Invalidated records drop out entirely (the ledger keeps their history).
 */
export const foldMemory = (
  events: ReadonlyArray<MemoryEvent>,
): ReadonlyArray<MemoryRecord> => [
  ...events
    .reduce(
      (active, event) =>
        Match.value(event).pipe(
          Match.tag("create", (e) =>
            new Map([
              ...active,
              [
                e.id,
                new MemoryRecord({
                  id: e.id,
                  topic: e.topic,
                  statement: e.statement,
                  corroboration: 1,
                  createdAt: e.provenance.at,
                  updatedAt: e.provenance.at,
                  sources: [e.provenance.runId],
                }),
              ],
            ]),
          ),
          Match.tag("update", (e) =>
            Option.match(Option.fromNullable(active.get(e.id)), {
              onNone: () => active,
              onSome: (record) =>
                new Map([
                  ...active,
                  [
                    e.id,
                    new MemoryRecord({
                      ...record,
                      statement: e.statement,
                      updatedAt: e.provenance.at,
                      sources: withSource(record.sources, e.provenance.runId),
                    }),
                  ],
                ]),
            }),
          ),
          Match.tag("corroborate", (e) =>
            Option.match(Option.fromNullable(active.get(e.id)), {
              onNone: () => active,
              onSome: (record) =>
                new Map([
                  ...active,
                  [
                    e.id,
                    new MemoryRecord({
                      ...record,
                      corroboration: record.corroboration + 1,
                      updatedAt: e.provenance.at,
                      sources: withSource(record.sources, e.provenance.runId),
                    }),
                  ],
                ]),
            }),
          ),
          Match.tag("invalidate", (e) =>
            new Map([...active].filter(([id]) => id !== e.id)),
          ),
          Match.exhaustive,
        ),
      new Map<MemoryId, MemoryRecord>(),
    )
    .values(),
]
