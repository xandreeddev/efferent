import { Seq, stored, TurnNumber } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import {
  aliasedEvent, curatedEvent, curationFailedEvent, EntityId, entityEvent, memoryEndedEvent, memoryEvent, MemoryId, memoryRestatedEvent, SourceId, sourceEvent,
} from "./knowledge.entity.js"
import type { EndedWhy, MemoryData, MemoryKind, SourceData, SourcePart } from "./knowledge.entity.js"

/*
 * What the knowledge contract's tests build their journals with: a draft for each record, in a few words, and a
 * journal stamped with times a test names. The build leaves this file out.
 */

/** Noon, UTC, of a day (`2026-11-12`), in milliseconds. */
export const noon = (day: string): number => Date.parse(`${day}T12:00:00Z`)

/**
 * A journal from drafts: places count from one, each record in a turn of its own. A number among them is a time,
 * in milliseconds, at which the records after it are stored (noon of 12 November 2026 until one is given).
 */
export const journalOf = (...records: ReadonlyArray<StoredDraft | number>): ReadonlyArray<StoredEvent> => {
  let at = noon("2026-11-12")
  const events: Array<StoredEvent> = []
  for (const record of records) {
    if (typeof record === "number") at = record
    else events.push({ ...record, seq: Seq.make(events.length + 1), at, turn: TurnNumber.make(events.length + 1) })
  }
  return events
}

/** The parts of a source in a few words: `["user", "…"]`. */
export const parts = (...said: ReadonlyArray<readonly [by: SourcePart["by"], text: string]>): readonly [SourcePart, ...Array<SourcePart>] => {
  const [first, ...rest] = said.map(([by, text]) => ({ by, text }))
  return [first ?? { by: "user", text: "Hello." }, ...rest]
}

/** A source's data: its id, what was said, and when (noon of 12 November 2026 unless given). */
export const sourceOf = (id: string, said: readonly [SourcePart, ...Array<SourcePart>], more: Partial<Pick<SourceData, "context" | "at" | "from" | "meta">> = {}): SourceData =>
  ({ id: SourceId.make(id), said, at: noon("2026-11-12"), ...more })

export const source = (id: string, said: readonly [SourcePart, ...Array<SourcePart>] = parts(["user", "Hello."]), more: Partial<Pick<SourceData, "context" | "at" | "from" | "meta">> = {}): StoredDraft =>
  stored(sourceEvent, sourceOf(id, said, more))

export const entity = (id: string, name: string, kind = "person", from = "s1"): StoredDraft =>
  stored(entityEvent, { id: EntityId.make(id), name, kind, source: SourceId.make(from) })

export const aliased = (id: string, alias: string, from = "s1"): StoredDraft =>
  stored(aliasedEvent, { id: EntityId.make(id), alias, source: SourceId.make(from) })

export const memory = (id: string, text: string, about: ReadonlyArray<string>, more: { readonly kind?: MemoryKind; readonly quote?: string; readonly by?: MemoryData["by"]; readonly from?: string; readonly on?: string } = {}): StoredDraft =>
  stored(memoryEvent, {
    id: MemoryId.make(id), kind: more.kind ?? "fact", text, about: about.map((one) => EntityId.make(one)), quote: more.quote ?? text, by: more.by ?? "user",
    source: SourceId.make(more.from ?? "s1"), ...(more.on === undefined ? {} : { on: more.on }),
  })

export const restated = (id: string, from = "s1", quote = "said again"): StoredDraft =>
  stored(memoryRestatedEvent, { id: MemoryId.make(id), source: SourceId.make(from), quote })

export const ended = (id: string, why: EndedWhy, more: { readonly by?: string; readonly from?: string } = {}): StoredDraft =>
  stored(memoryEndedEvent, { id: MemoryId.make(id), why, source: SourceId.make(more.from ?? "s1"), ...(more.by === undefined ? {} : { by: MemoryId.make(more.by) }) })

export const curated = (from: string, kept = 0): StoredDraft => stored(curatedEvent, { source: SourceId.make(from), calls: 1, kept, dropped: [] })

export const failed = (from: string, attempt: number, reason: string): StoredDraft => stored(curationFailedEvent, { source: SourceId.make(from), attempt, reason })
