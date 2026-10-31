import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { entriesOfEvents, JOURNAL_KINDS, journalSchemaOf, MEMORY_KINDS, readStored, readStoredKeys, replayModelRequest, RESERVED_KINDS, RunId, SessionHeader, SessionLogEvent, STORED_FORMAT, StoredData } from "@xandreed/core"
import type { StoredKind } from "@xandreed/core"
import { TASK_ANSWERED, TASK_QUESTIONED, TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskAnswered, TaskQuestioned, TaskCancelled, TaskResult, TaskStarted } from "@xandreed/plugin-tasks"

/*
 * What a release stored must stay readable. Each `fixtures/journal-<version>.json`
 * holds session journals recorded from that release's code by
 * `scripts/record-journal-fixture.ts`: every kind the framework reserved
 * then (listed in the fixture) and stores, the tasks plugin's records, the
 * inbox and a host event. This code decodes every event of every fixture with its kind's
 * schema, rebuilds the memory log from them, and rebuilds every model
 * request from its stored header. A change that breaks one of these breaks
 * every session that release wrote.
 */

const Fixture = Schema.Struct({
  format: Schema.Literal(1),
  version: Schema.String,
  /** The stored format that version wrote (`STORED_FORMAT`); fixtures recorded before it existed have none. */
  storedFormat: Schema.optionalKey(Schema.Int),
  /** The kinds `RESERVED_KINDS` held in that version. */
  reserved: Schema.Array(Schema.String),
  sessions: Schema.Array(Schema.Struct({ header: SessionHeader, events: Schema.Array(SessionLogEvent) })),
})

/** The tasks plugin's own records: not the framework's, decoded with the plugin's schemas. */
const taskSchemas: ReadonlyMap<string, Schema.Codec<unknown, unknown>> = new Map<string, Schema.Codec<unknown, unknown>>([
  [TASK_STARTED, TaskStarted], [TASK_RESULT, TaskResult], [TASK_CANCELLED, TaskCancelled],
  [TASK_QUESTIONED, TaskQuestioned], [TASK_ANSWERED, TaskAnswered],
])

const directory = join(import.meta.dir, "../fixtures")
const files = (await readdir(directory)).filter((name) => /^journal-.+\.json$/.test(name)).sort()
const fixtures = await Effect.runPromise(Effect.forEach(files, (file) => Effect.promise(() => Bun.file(join(directory, file)).json()).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Fixture)),
  Effect.map((fixture) => ({ file, fixture })),
)))

/** The formats docs/stored-format.json records, each with the fingerprint of its shapes. */
const StoredFormats = Schema.Struct({ history: Schema.Array(Schema.Struct({ format: Schema.Int, fingerprint: Schema.String })) })
const recordedFormats = await Effect.runPromise(Effect.tryPromise(() => Bun.file(join(import.meta.dir, "../../../docs/stored-format.json")).text()).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFormats))),
  Effect.map((record) => record.history.map((row) => row.format)),
))

test("a fixture's stored format, when it names one, is one this release reads and docs/stored-format.json records", () => {
  expect(recordedFormats).toContain(STORED_FORMAT)
  expect(fixtures.flatMap(({ file, fixture }) => fixture.storedFormat === undefined || (fixture.storedFormat <= STORED_FORMAT && recordedFormats.includes(fixture.storedFormat)) ? [] : [`${file}: stored format ${fixture.storedFormat}`])).toEqual([])
})

test("the journals of every release since 0.13.0 are kept", () => {
  expect(files).toContain("journal-0.13.0.json")
  expect(files).toContain("journal-0.14.0.json")
  expect(fixtures.filter(({ file, fixture }) => file !== `journal-${fixture.version}.json`).map(({ file }) => file)).toEqual([])
})

test("the 0.14.0 fixture keeps the exact bytes published with its release tag", async () => {
  const released = await readFile(join(directory, "journal-0.14.0.json"))
  expect(createHash("sha256").update(released).digest("hex")).toBe("342bd192e3c09c3cce7ce2737cc91e14e2389e3bb2cd692e9fc2c2d80a518800")
})

test("development retains current format and reserved-kind coverage independently of releases", () => {
  const current = fixtures.find(({ file }) => file === "journal-unreleased.json")?.fixture
  expect(current?.version).toBe("unreleased")
  expect(current?.storedFormat).toBe(STORED_FORMAT)
  expect(current?.reserved).toEqual([...RESERVED_KINDS])
  expect(current?.reserved).toContain("model.called")
})

fixtures.forEach(({ fixture }) => describe(`a ${fixture.version} session journal`, () => {
  const events = fixture.sessions.flatMap((session) => session.events)
  const kinds = new Set(events.map((event) => event.kind))

  test("holds every journal kind its version reserved, task records, the inbox and a host event; each is still reserved", () => {
    expect(fixture.reserved.length).toBeGreaterThan(0)
    // A reserved bus name the journal never stores as itself (`assistant.message`, from 0.14.0) is not in it.
    expect(fixture.reserved.filter((kind) => JOURNAL_KINDS.includes(kind) && !kinds.has(kind))).toEqual([])
    expect(fixture.reserved.filter((kind) => !RESERVED_KINDS.includes(kind))).toEqual([])
    expect([TASK_STARTED, TASK_RESULT, TASK_CANCELLED, "note.prepared"].filter((kind) => !kinds.has(kind))).toEqual([])
  })

  test("every event decodes with its kind's journal schema", () => {
    const undecodable = events.flatMap((event) => {
      const schema = Option.orElse(journalSchemaOf(event.kind), () => Option.fromNullishOr(taskSchemas.get(event.kind)))
      if (Option.isNone(schema)) return RESERVED_KINDS.includes(event.kind) ? [`${event.kind}: no schema`] : []
      return Option.isSome(Schema.decodeUnknownOption(schema.value)(event.data)) ? [] : [`${event.session}#${event.seq} ${event.kind}`]
    })
    expect(undecodable).toEqual([])
    // Kinds without a schema are the host's own.
    expect([...kinds].filter((kind) => Option.isNone(journalSchemaOf(kind)) && !taskSchemas.has(kind))).toEqual(["note.prepared"])
  })

  test("every event of a kind read back by its fields decodes through readStored, and its keys through readStoredKeys", async () => {
    const kinds = Object.keys(StoredData).filter((kind): kind is StoredKind => kind in StoredData)
    const read = await Effect.runPromise(Effect.forEach(kinds, (kind) => readStored(kind, events).pipe(Effect.map((stored) => [kind, stored.length] as const)), { concurrency: 1 }))
    expect(read).toEqual(kinds.map((kind) => [kind, events.filter((event) => event.kind === kind).length] as const))
    // A later release may add a reader for a kind this fixture did not reserve.
    expect(read.filter(([kind, count]) => fixture.reserved.includes(kind) && count === 0).map(([kind]) => kind)).toEqual([])
    const starts = await Effect.runPromise(readStoredKeys("turn.started", events))
    const headers = await Effect.runPromise(readStoredKeys("request.prepared", events))
    expect([starts.length, headers.length]).toEqual([events.filter((event) => event.kind === "turn.started").length, events.filter((event) => event.kind === "request.prepared").length])
  })

  test("the memory log rebuilds from the stored events", async () => {
    const parent = fixture.sessions[0]?.events ?? []
    const entries = await Effect.runPromise(entriesOfEvents(parent))
    expect(entries.length).toBe(parent.filter((event) => MEMORY_KINDS.includes(event.kind)).length)
    expect(entries.map((entry) => entry.body._tag)).toContain("ToolDigest")
  })

  test("every stored model request rebuilds from its header and the memory before it", async () => {
    const parent = fixture.sessions[0]?.events ?? []
    const headers = parent.filter((event) => event.kind === "request.prepared")
    const rebuilt = await Effect.runPromise(Effect.forEach(headers, (header) =>
      replayModelRequest(parent, RunId.make(String(header.data.runId)), Number(header.data.step)).pipe(Effect.map((request) => request.prompt.content.length))))
    expect(headers.length).toBeGreaterThan(0)
    expect(rebuilt.every((messages) => messages > 1)).toBe(true)
  })
}))
