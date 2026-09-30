import { Effect, Option } from "effect"
import type { Context } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { SessionLog } from "../ports/session-log.port.js"
import type { JsonObject, SessionDraft, SessionHeader } from "./session-log.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

const fail = (check: string, message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check, message)

/** A fresh id per session, so the kit can run against a shared store. */
const freshId = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

const headerOf = (id: ConversationId, owner: string, parent: Option.Option<{ readonly id: ConversationId; readonly through: number; readonly turnAtFork: number }> = Option.none()): SessionHeader => ({
  id, owner, origin: "user", createdAt: 1_767_225_600_000, meta: { title: "conformance", nested: { list: [1, "two", null] } }, parent,
})

const draft = (kind: string, data: JsonObject, turn: Option.Option<number> = Option.none()): SessionDraft => ({ kind, turn, data })

const noEvents = { notAfter: Option.none<number>(), state: Option.none<JsonObject>() }

/** A value that must come back equal whatever key order the store keeps. */
const rich: JsonObject = { zeta: 1, alpha: { b: [true, false, { y: "ü", x: 0.5 }], a: "text ✓" }, empty: {}, list: [] }

/**
 * The SessionLog contract, as checks any backend must pass: dense sequence
 * numbers, one revision per commit, compare-and-swap, the `notAfter` clock
 * check, JSON kept by value, reads by position and kind, listing order,
 * children and their removal. Every check uses fresh ids and a fresh owner,
 * so the kit is safe on a shared database.
 */
export const sessionLogConformance = (log: Log): ReadonlyArray<ConformanceCheck> => {
  const check = (name: string, id: string, body: (owner: string) => Effect.Effect<void, unknown>): ConformanceCheck => ({
    name,
    run: freshId.pipe(
      Effect.flatMap((owner) => body(`owner-${owner}`)),
      Effect.catch((error: unknown) => error instanceof ConformanceFailure ? Effect.fail(error)
        : fail(id, `unexpected ${typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "error"}: ${JSON.stringify(error)}`)),
    ),
  })

  return [
    check("a new session is empty: seq 0, revision 0, the header as given", "create", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const created = yield* log.create(headerOf(id, owner))
      const head = yield* log.head(id)
      yield* expect("create", created.seq === 0 && created.revision === 0 && head.seq === 0 && head.revision === 0, `seq ${head.seq}, revision ${head.revision}`)
      yield* expect("create", head.header.owner === owner && head.header.origin === "user" && Option.isNone(head.header.parent), "the header changed")
      yield* expect("create", canonicalJson(head.header.meta) === canonicalJson(headerOf(id, owner).meta), "meta changed")
      yield* expect("create", canonicalJson(head.state) === "{}", "a new session has state")
      const again = yield* Effect.flip(log.create(headerOf(id, owner)))
      yield* expect("create", again._tag === "SessionExists", `creating twice gave ${again._tag}`)
    })),
    check("commits number events densely from 1, in order, and bump the revision once", "append", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      const first = yield* log.commit(id, { expect: 0, ...noEvents, events: [draft("a", { n: 1 }, Option.some(1)), draft("b", { n: 2 }, Option.some(1))] })
      const second = yield* log.commit(id, { expect: 1, ...noEvents, events: [draft("c", { n: 3 })] })
      yield* expect("append", first.revision === 1 && second.revision === 2 && second.seq === 3, `revisions ${first.revision}, ${second.revision}; seq ${second.seq}`)
      yield* expect("append", first.events.map((event) => event.seq).join() === "1,2" && second.events.map((event) => event.seq).join() === "3", "sequence numbers are not dense")
      const stored = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* expect("append", stored.map((event) => `${event.seq}:${event.kind}:${Option.getOrElse(event.turn, () => 0)}`).join() === "1:a:1,2:b:1,3:c:0", "the log differs")
      yield* expect("append", stored.every((event) => event.session === id && event.at === (event.seq < 3 ? first.at : second.at)), "event times are not the commit's time")
      const head = yield* log.head(id)
      yield* expect("append", head.seq === 3 && head.revision === 2 && head.updatedAt === second.at, `head seq ${head.seq}, revision ${head.revision}`)
    })),
    check("a state-only commit bumps the revision and appends nothing", "state", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      const committed = yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [], state: Option.some({ open: { turn: 1 } }) })
      const head = yield* log.head(id)
      yield* expect("state", committed.revision === 1 && committed.events.length === 0 && head.seq === 0 && head.revision === 1, `revision ${head.revision}, seq ${head.seq}`)
      yield* expect("state", canonicalJson(head.state) === canonicalJson({ open: { turn: 1 } }), "the state was not replaced")
      yield* log.commit(id, { expect: 1, ...noEvents, events: [draft("a", {})] })
      yield* expect("state", canonicalJson((yield* log.head(id)).state) === canonicalJson({ open: { turn: 1 } }), "a commit without state changed it")
    })),
    check("a commit against a stale revision is refused and writes nothing", "conflict", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      yield* log.commit(id, { expect: 0, ...noEvents, events: [draft("a", {})] })
      const refused = yield* Effect.flip(log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("b", {})], state: Option.some({ lost: true }) }))
      yield* expect("conflict", refused._tag === "RevisionConflict" && refused.expected === 0 && refused.actual === 1, `refused with ${JSON.stringify(refused)}`)
      const head = yield* log.head(id)
      yield* expect("conflict", head.seq === 1 && head.revision === 1 && canonicalJson(head.state) === "{}", "a refused commit wrote something")
    })),
    check("a commit after its notAfter is refused by the storage clock and writes nothing", "expiry", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      const head = yield* log.head(id)
      const refused = yield* Effect.flip(log.commit(id, { expect: 0, notAfter: Option.some(head.now - 60_000), events: [draft("late", {})], state: Option.none() }))
      yield* expect("expiry", refused._tag === "LeaseExpired", `refused with ${refused._tag}`)
      const inTime = yield* log.commit(id, { expect: 0, notAfter: Option.some(head.now + 600_000), events: [draft("on-time", {})], state: Option.none() })
      yield* expect("expiry", inTime.revision === 1 && (yield* log.head(id)).seq === 1, "a commit in time was refused or the late one was written")
    })),
    check("of concurrent commits against one revision, exactly one wins", "race", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      const attempts = yield* Effect.forEach([0, 1, 2, 3, 4, 5, 6, 7], (n) =>
        Effect.result(log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("attempt", { n })], state: Option.some({ winner: n }) })), { concurrency: "unbounded" })
      const won = attempts.filter((attempt) => attempt._tag === "Success")
      const refused = attempts.filter((attempt) => attempt._tag === "Failure" && attempt.failure._tag === "RevisionConflict")
      yield* expect("race", won.length === 1 && refused.length === 7, `${won.length} won, ${refused.length} refused`)
      const head = yield* log.head(id)
      const events = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* expect("race", head.revision === 1 && events.length === 1 && canonicalJson(head.state) === canonicalJson({ winner: events[0]?.data.n }), "the winner's state and event disagree")
    })),
    check("event data and state come back equal, whatever key order the store keeps", "json", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("rich", rich)], state: Option.some(rich) })
      const [event] = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* expect("json", event !== undefined && canonicalJson(event.data) === canonicalJson(rich), `data came back as ${JSON.stringify(event?.data)}`)
      yield* expect("json", canonicalJson((yield* log.head(id)).state) === canonicalJson(rich), "the state came back different")
    })),
    check("input and returned JSON are detached from stored heads and events", "json-isolation", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const header = headerOf(id, owner)
      const expectedMeta = canonicalJson(header.meta)
      const created = yield* log.create(header)
      /** Change a value at the top and deep inside (`nested.text`, `nested.list[0]`, `list[0]`): a shallow copy keeps the inner ones shared. */
      const change = (json: JsonObject, by: string) => {
        Reflect.set(json, "changed", by)
        if (typeof json.nested === "object" && json.nested !== null) {
          Reflect.set(json.nested, "text", by)
          if ("list" in json.nested && typeof json.nested.list === "object" && json.nested.list !== null) Reflect.set(json.nested.list, "0", by)
        }
        if (typeof json.list === "object" && json.list !== null) Reflect.set(json.list, "0", by)
      }
      change(header.meta, "input")
      change(created.header.meta, "create")
      Reflect.set(created.state, "changed", "create")
      yield* expect("json-isolation", canonicalJson((yield* log.head(id)).state) === "{}", "a returned create state changed the new session")
      const value = { nested: { text: "original" }, list: ["original"] }
      const expected = canonicalJson(value)
      const committed = yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("fact", value)], state: Option.some(value) })
      value.nested.text = "input"
      value.list[0] = "input"
      const head = yield* log.head(id)
      const listed = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })
      const events = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      change(head.header.meta, "output")
      change(head.state, "output")
      listed.forEach((entry) => { change(entry.header.meta, "output"); change(entry.state, "output") })
      committed.events.forEach((event) => change(event.data, "output"))
      events.forEach((event) => change(event.data, "output"))
      const again = yield* log.head(id)
      const reread = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* expect("json-isolation", again.revision === 1 && again.seq === 1, "mutating a returned value moved the head")
      yield* expect("json-isolation", canonicalJson(again.header.meta) === expectedMeta, "input, create, head or list metadata changed the stored header")
      yield* expect("json-isolation", canonicalJson(again.state) === expected, "input, head or list state changed the stored state")
      yield* expect("json-isolation", reread.length === 1 && canonicalJson(reread[0]!.data) === expected, "input, commit or read data changed the stored event")
    })),
    check("reads return events after a position, ascending, filtered by kind and limited", "read", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create(headerOf(id, owner))
      yield* log.commit(id, { expect: 0, ...noEvents, events: ["a", "b", "a", "c", "a"].map((kind, n) => draft(kind, { n })) })
      const seqs = (events: ReadonlyArray<{ readonly seq: number }>) => events.map((event) => event.seq).join()
      yield* expect("read", seqs(yield* log.read(id, { after: 2, limit: Option.none(), kinds: [] })) === "3,4,5", "after is not exclusive")
      yield* expect("read", seqs(yield* log.read(id, { after: 0, limit: Option.none(), kinds: ["a"] })) === "1,3,5", "kinds do not filter")
      yield* expect("read", seqs(yield* log.read(id, { after: 1, limit: Option.some(2), kinds: ["a", "c"] })) === "3,4", "limit does not apply after the filter")
      yield* expect("read", (yield* log.read(id, { after: 5, limit: Option.none(), kinds: [] })).length === 0, "reading past the end returned events")
    })),
    check("a listing holds the owner's top-level sessions, newest first, before the cursor", "list", (owner) => Effect.gen(function* () {
      const [first, second, third] = [yield* freshId, yield* freshId, yield* freshId]
      yield* log.create(headerOf(first, owner))
      yield* log.create(headerOf(second, owner))
      yield* log.create(headerOf(third, owner))
      yield* log.create(headerOf(yield* freshId, `${owner}-other`))
      yield* log.create(headerOf(yield* freshId, owner, Option.some({ id: first, through: 0, turnAtFork: 0 })))
      yield* Effect.sleep("5 millis")
      yield* log.commit(second, { expect: 0, ...noEvents, events: [draft("touch", {})] })
      const listed = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })
      yield* expect("list", listed.length === 3 && listed[0]?.header.id === second, `listed ${listed.map((head) => head.header.id).join()}`)
      yield* expect("list", listed.every((head, index) => index === 0 || (listed[index - 1]!.updatedAt > head.updatedAt
        || (listed[index - 1]!.updatedAt === head.updatedAt && listed[index - 1]!.header.id > head.header.id))), "the listing is not newest first, then by id")
      const cursor = listed[0]!
      const rest = yield* log.list({ owner, limit: 10, before: Option.some({ updatedAt: cursor.updatedAt, id: cursor.header.id }), parent: Option.none() })
      yield* expect("list", rest.length === 2 && rest.every((head) => head.header.id !== second), "the cursor is not exclusive")
      yield* expect("list", (yield* log.list({ owner, limit: 1, before: Option.none(), parent: Option.none() })).length === 1, "the limit is ignored")
      const children = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.some(first) })
      yield* expect("list", children.length === 1 && Option.exists(children[0]!.header.parent, (parent) => parent.id === first), "children are not listed under their parent")
    })),
    check("a child needs its parent, and removing a session removes its events and children", "lineage", (owner) => Effect.gen(function* () {
      const [parent, child, grandchild, orphan] = [yield* freshId, yield* freshId, yield* freshId, yield* freshId]
      const lost = yield* Effect.flip(log.create(headerOf(orphan, owner, Option.some({ id: yield* freshId, through: 0, turnAtFork: 0 }))))
      yield* expect("lineage", lost._tag === "SessionMissing", `a child of a missing parent gave ${lost._tag}`)
      yield* log.create(headerOf(parent, owner))
      yield* log.commit(parent, { expect: 0, ...noEvents, events: [draft("a", {})] })
      const forked = yield* log.create(headerOf(child, owner, Option.some({ id: parent, through: 1, turnAtFork: 1 })))
      yield* expect("lineage", Option.exists(forked.header.parent, (lineage) => lineage.id === parent && lineage.through === 1 && lineage.turnAtFork === 1), "the lineage changed")
      yield* log.create(headerOf(grandchild, owner, Option.some({ id: child, through: 0, turnAtFork: 1 })))
      yield* log.remove(parent)
      const gone = yield* Effect.forEach([parent, child, grandchild], (id) => Effect.flip(log.head(id)))
      yield* expect("lineage", gone.every((error) => error._tag === "SessionMissing"), "a removed session or child is still there")
      const read = yield* Effect.flip(log.read(parent, { after: 0, limit: Option.none(), kinds: [] }))
      yield* expect("lineage", read._tag === "SessionMissing", "a removed session still reads")
      yield* log.remove(parent)
    })),
    check("a missing session is SessionMissing to every operation", "missing", () => Effect.gen(function* () {
      const id = yield* freshId
      const errors = [
        yield* Effect.flip(log.head(id)),
        yield* Effect.flip(log.read(id, { after: 0, limit: Option.none(), kinds: [] })),
        yield* Effect.flip(log.commit(id, { expect: 0, ...noEvents, events: [draft("a", {})] })),
      ]
      yield* expect("missing", errors.every((error) => error._tag === "SessionMissing"), `got ${errors.map((error) => error._tag).join()}`)
    })),
  ]
}
