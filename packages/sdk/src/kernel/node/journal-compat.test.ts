import { describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import {
  assistantMessageEvent, dataOf, JOURNAL_FORMAT, Journal, JournalStorage, kernel, listenerFailedEvent, SessionHeader, Sessions, toolResultEvent, turnEndedEvent,
  turnStartedEvent, userMessageEvent,
} from "@xandreed/core/kernel"
import type { StoredDefinition } from "@xandreed/core/kernel"
import {
  aliasedEvent, curatedEvent, curationFailedEvent, decidedEvent, entityEvent, factsOf, FACTS_OWNER, forgottenEvent, grantsOf, KNOWLEDGE_OWNER, knowledgeOf, learnedEvent, Memory,
  memoryEndedEvent, memoryEvent, memoryRestatedEvent, recoverTurns, sessions, sourceEvent, standing, summarizedEvent, Summarizer, summaryMemory, turnsOf, viewEvent,
  windowDroppedEvent,
} from "../index.js"
import { DIRECTORY_LAYOUT, DIRECTORY_STORE } from "./journal-directory/directory-journal.entity.js"
import { fileNameOf, lineOf } from "./journal-directory/directory-journal.entity.functions.js"
import { directoryJournal } from "./index.js"
import { scratch } from "./testing.js"

/*
 * The journals each release of the kernel stored (`fixtures/journal-<version>.json`, recorded by
 * `scripts/record-journal-fixture.ts`): historical evidence, kept byte for byte. A journal of the format this kernel
 * writes (`JOURNAL_FORMAT`) replays under today's definitions and stock plugins; one of another format is refused
 * where a turn would open (`FormatMismatch`) and left as it is, never migrated or decoded by compatibility code.
 * Each is put into a durable directory journal as that store writes it, and read through the stock session plugin.
 */

const Fixture = Schema.Struct({
  format: Schema.Literal(2),
  version: Schema.String,
  /** The journal format the version wrote (`JOURNAL_FORMAT`). */
  journalFormat: Schema.Int,
  sessions: Schema.Array(Schema.Struct({ header: Schema.JsonObject, events: Schema.Array(Schema.JsonObject) })),
})
type Fixture = typeof Fixture.Type

const directory = join(import.meta.dir, "../../../fixtures")
const files = (await readdir(directory)).filter((name) => /^journal-.+\.json$/.test(name)).sort()
const fixtures = await Effect.runPromise(Effect.forEach(files, (file) => Effect.tryPromise(() => readFile(join(directory, file), "utf8")).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture))),
  Effect.map((fixture) => ({ file, fixture })),
), { concurrency: 1 }))

/** Every record a stock part of today's kernel stores, by name. */
const definitions: ReadonlyMap<string, StoredDefinition<Schema.Json>> = new Map<string, StoredDefinition<Schema.Json>>([
  userMessageEvent, assistantMessageEvent, toolResultEvent, turnStartedEvent, turnEndedEvent, listenerFailedEvent, decidedEvent, learnedEvent, forgottenEvent,
  summarizedEvent, windowDroppedEvent, viewEvent, sourceEvent, entityEvent, aliasedEvent, memoryEvent, memoryRestatedEvent, memoryEndedEvent, curatedEvent,
  curationFailedEvent,
].map((definition): readonly [string, StoredDefinition<Schema.Json>] => [definition.name, definition as StoredDefinition<Schema.Json>]))

/** A directory journal holding `sessions` as that store writes them: its marker, and a file per session, a line per header and event. */
const storeOf = (path: string, sessions: Fixture["sessions"]) => Effect.promise(async () => {
  await mkdir(join(path, "sessions"), { recursive: true })
  await writeFile(join(path, "store.json"), JSON.stringify({ store: DIRECTORY_STORE, layout: DIRECTORY_LAYOUT }))
  for (const session of sessions) {
    const lines = [session.header, ...session.events].map((value) => lineOf(JSON.stringify(value)))
    await writeFile(join(path, "sessions", fileNameOf(String(session.header.id))), Buffer.concat(lines))
  }
})

/** The bytes of every session file of a directory journal, by name. */
const bytesOf = (path: string) => Effect.promise(async () => {
  const names = (await readdir(join(path, "sessions"))).sort()
  return await Promise.all(names.map(async (name) => [name, (await readFile(join(path, "sessions", name))).toString("base64")] as const))
})

/** The stock stack over a directory journal, with a summary memory whose summarizer must never be asked. */
const stackOver = (path: string) => summaryMemory({ budgetTokens: 1_000_000, keepTurns: 0 }).pipe(
  Layer.provide(Layer.succeed(Summarizer, Summarizer.of({ summarize: () => Effect.die("a replayed journal asked for a new summary") }))),
  Layer.provideMerge(sessions().pipe(Layer.provideMerge(directoryJournal({ directory: path })), Layer.provideMerge(kernel()))),
)

test("each fixture is named for the version that recorded it, and the development one is of today's format", () => {
  expect(files).toContain("journal-unreleased.json")
  expect(fixtures.filter(({ file, fixture }) => file !== `journal-${fixture.version}.json`).map(({ file }) => file)).toEqual([])
  expect(fixtures.find(({ file }) => file === "journal-unreleased.json")?.fixture.journalFormat).toBe(JOURNAL_FORMAT)
})

fixtures.filter(({ fixture }) => fixture.journalFormat === JOURNAL_FORMAT).forEach(({ fixture }) => describe(`the ${fixture.version} journals`, () => {
  const journals = Effect.runSync(Schema.decodeUnknownEffect(Schema.Array(Journal))(fixture.sessions))
  const ofOwner = (owner: string) => journals.filter((journal) => journal.header.owner === owner)

  test("decode as journals of today's kernel, every record with the definition of its name", () => {
    const records = journals.flatMap((journal) => journal.events)
    expect(records.length).toBeGreaterThan(0)
    const unread = records.flatMap((record) => {
      const definition = definitions.get(record.name)
      return definition !== undefined && Option.isSome(dataOf(definition, record)) ? [] : [`${record.name} at ${record.seq}`]
    })
    expect(unread).toEqual([])
  })

  test("hold a tool call, an approval for good, a remembered fact, a summary and curated knowledge, each read back by its fold", () => {
    const conversation = journals.find((journal) => journal.header.owner !== FACTS_OWNER && journal.header.owner !== KNOWLEDGE_OWNER)
    const turns = turnsOf(conversation?.events ?? [])
    expect(turns.length).toBeGreaterThan(1)
    expect(turns.every((turn) => Option.isSome(turn.closed))).toBe(true)
    expect(turns.flatMap((turn) => turn.steps.flatMap((step) => step.calls)).filter((call) => Option.isSome(call.result)).length).toBeGreaterThan(0)
    expect(grantsOf(conversation?.events ?? []).length).toBeGreaterThan(0)
    expect(conversation?.events.some((event) => event.name === summarizedEvent.name)).toBe(true)
    expect(ofOwner(FACTS_OWNER).flatMap((journal) => factsOf(journal.events)).length).toBeGreaterThan(0)
    const knowledge = knowledgeOf(ofOwner(KNOWLEDGE_OWNER)[0]?.events ?? [])
    expect(knowledge.sources.length).toBeGreaterThan(0)
    expect(knowledge.sources.every((source) => source.state._tag === "Curated")).toBe(true)
    expect(standing(knowledge).length).toBeGreaterThan(0)
  })

  test("a store that holds them reads them back as they are; a new turn opens on each, its memory built from the stored summary", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = join(yield* scratch, "journal")
      yield* storeOf(path, fixture.sessions)
      return yield* Effect.gen(function* () {
        const recovered = yield* recoverTurns
        const storage = yield* JournalStorage
        const read = yield* Effect.forEach(journals, (journal) => storage.read(journal.header.id), { concurrency: 1 })
        const all = yield* Sessions
        const memory = yield* Memory
        const opened = yield* Effect.forEach(journals, (journal) => all.turn(journal.header.id, (session) => Effect.succeed(Number(session.turn))), { concurrency: 1 })
        const conversation = journals.find((journal) => journal.events.some((event) => event.name === summarizedEvent.name))!
        const context = yield* all.turn(conversation.header.id, (session) => memory.context(session))
        return { recovered: recovered.closed.length + recovered.unreadable.length, read, opened, first: context[0] }
      }).pipe(Effect.provide(stackOver(path)))
    })))
    expect(result.recovered).toBe(0)
    expect(Schema.encodeSync(Schema.Array(Journal))(result.read)).toEqual(Schema.encodeSync(Schema.Array(Journal))(journals))
    expect(result.opened).toEqual(journals.map((journal) => turnsOf(journal.events).length + 1))
    expect(JSON.stringify(result.first)).toContain("conversation-summary")
  }, 30_000)
}))

/** A journal of another format: refused where a turn would open, passed over by recovery, and left byte for byte. */
const refusedUnchanged = (sessions: Fixture["sessions"]) => Effect.scoped(Effect.gen(function* () {
  const path = join(yield* scratch, "journal")
  yield* storeOf(path, sessions)
  const before = yield* bytesOf(path)
  const outcome = yield* Effect.gen(function* () {
    const recovered = yield* recoverTurns
    const all = yield* Sessions
    const refused = yield* Effect.forEach(sessions, (session) => Effect.flip(all.turn(Schema.decodeUnknownSync(SessionHeader)(session.header).id, () => Effect.void)), { concurrency: 1 })
    const read = yield* Effect.forEach(sessions, (session) => all.read(Schema.decodeUnknownSync(SessionHeader)(session.header).id), { concurrency: 1 })
    return { recovered: recovered.closed.length, refused: refused.map((error) => error._tag === "SessionRefused" ? error.reason : error._tag), read: read.length }
  }).pipe(Effect.provide(stackOver(path)))
  return { ...outcome, unchanged: JSON.stringify(yield* bytesOf(path)) === JSON.stringify(before) }
}))

fixtures.filter(({ fixture }) => fixture.journalFormat !== JOURNAL_FORMAT).forEach(({ fixture }) => test(`the ${fixture.version} journals (format ${fixture.journalFormat}) are refused without change`, async () => {
  const result = await Effect.runPromise(refusedUnchanged(fixture.sessions))
  expect(result).toEqual({ recovered: 0, refused: fixture.sessions.map(() => "FormatMismatch"), read: fixture.sessions.length, unchanged: true })
}, 30_000))

test("a journal of another format, today's recording stamped with the next one, is refused without change", async () => {
  const current = fixtures.find(({ file }) => file === "journal-unreleased.json")!.fixture
  const next = current.sessions.map((session) => ({ ...session, header: { ...session.header, format: JOURNAL_FORMAT + 1 } }))
  const result = await Effect.runPromise(refusedUnchanged(next))
  expect(result).toEqual({ recovered: 0, refused: next.map(() => "FormatMismatch"), read: next.length, unchanged: true })
}, 30_000)

