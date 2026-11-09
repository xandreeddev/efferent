import { sessionRef } from "./session-log.entity.functions.js"
import { SessionIncarnation } from "./session-log.entity.js"
import { Effect, Option } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, freshId, headerOf } from "../conformance.functions.js"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { SessionLog } from "../ports/session-log.port.js"
import type { JsonObject, SessionDraft } from "./session-log.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

const draft = (kind: string, data: JsonObject, turn: Option.Option<number> = Option.none()): SessionDraft => ({ kind, turn, data })

const noEvents = { notAfter: Option.none<number>(), state: Option.none<JsonObject>() }

/** A value that must come back equal whatever key order the store keeps. */
const rich: JsonObject = { zeta: 1, alpha: { b: [true, false, { y: "ü", x: 0.5 }], a: "text ✓" }, empty: {}, list: [] }

/**
 * `value` with an `undefined` field named `unset`, as a host's optional field
 * left unset puts one there: the type rules it out, JavaScript does not. A
 * store drops the field, as JSON text does, rather than refusing the commit.
 */
const withUnset = (value: JsonObject): JsonObject => Object.assign<JsonObject, { readonly unset: undefined }>({ ...value }, { unset: undefined })

/** Whether a field named `unset` is still there, at any depth (JSON text would not show it). */
const keepsUnset = (value: unknown): boolean =>
  typeof value === "object" && value !== null && ("unset" in value || Object.values(value).some(keepsUnset))

/**
 * The SessionLog contract, as checks any backend must pass: dense sequence
 * numbers, one revision per commit, compare-and-swap, the `notAfter` clock
 * check, JSON kept by value, an event as large as a turn's images may make
 * it (`MEDIA_LIMITS.requestChars` base64 characters), reads by position and
 * kind, limited from either end (`from: "end"`: the newest matches, still
 * ascending), listing order, children and their removal, and incarnations (a
 * commit naming a session removed and created again under its id lands
 * nowhere). Every check uses fresh ids and a fresh owner, so the kit is safe
 * on a shared database.
 */
export const sessionLogConformance = (log: Log): ReadonlyArray<ConformanceCheck> => {
  return [
    check("a new session is empty: seq 0, revision 0, the header as given", "create", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const initial = { seeded: rich }
      const created = yield* log.create({ header: headerOf(id, owner), state: initial })
      const head = yield* log.head(id)
      yield* expect("create", created.seq === 0 && created.revision === 0 && head.seq === 0 && head.revision === 0, `seq ${head.seq}, revision ${head.revision}`)
      yield* expect("create", head.header.owner === owner && head.header.origin === "user" && Option.isNone(head.header.parent), "the header changed")
      yield* expect("create", canonicalJson(head.header.meta) === canonicalJson(headerOf(id, owner).meta), "meta changed")
      yield* expect("create", canonicalJson(head.state) === canonicalJson(initial), "the initial state changed or was not stored")
      const again = yield* Effect.flip(log.create({ header: headerOf(id, owner), state: {} }))
      yield* expect("create", again._tag === "SessionExists", `creating twice gave ${again._tag}`)
    })),
    check("commits number events densely from 1, in order, and bump the revision once", "append", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const first = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("a", { n: 1 }, Option.some(1)), draft("b", { n: 2 }, Option.some(1))] }) })
      const second = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 1, ...noEvents, events: [draft("c", { n: 3 })] }) })
      yield* expect("append", first.revision === 1 && second.revision === 2 && second.seq === 3, `revisions ${first.revision}, ${second.revision}; seq ${second.seq}`)
      yield* expect("append", first.events.map((event) => event.seq).join() === "1,2" && second.events.map((event) => event.seq).join() === "3", "sequence numbers are not dense")
      const stored = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      yield* expect("append", stored.map((event) => `${event.seq}:${event.kind}:${Option.getOrElse(event.turn, () => 0)}`).join() === "1:a:1,2:b:1,3:c:0", "the log differs")
      yield* expect("append", stored.every((event) => event.session === id && event.at === (event.seq < 3 ? first.at : second.at)), "event times are not the commit's time")
      const head = yield* log.head(id)
      yield* expect("append", head.seq === 3 && head.revision === 2 && head.updatedAt === second.at, `head seq ${head.seq}, revision ${head.revision}`)
    })),
    check("a state-only commit bumps the revision and appends nothing", "state", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const committed = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [], state: Option.some({ open: { turn: 1 } }) }) })
      const head = yield* log.head(id)
      yield* expect("state", committed.revision === 1 && committed.events.length === 0 && head.seq === 0 && head.revision === 1, `revision ${head.revision}, seq ${head.seq}`)
      yield* expect("state", canonicalJson(head.state) === canonicalJson({ open: { turn: 1 } }), "the state was not replaced")
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 1, ...noEvents, events: [draft("a", {})] }) })
      yield* expect("state", canonicalJson((yield* log.head(id)).state) === canonicalJson({ open: { turn: 1 } }), "a commit without state changed it")
    })),
    check("a commit against a stale revision is refused and writes nothing", "conflict", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("a", {})] }) })
      const refused = yield* Effect.flip(Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [draft("b", {})], state: Option.some({ lost: true }) }) }))
      yield* expect("conflict", refused._tag === "RevisionConflict" && refused.expected === 0 && refused.actual === 1, `refused with ${JSON.stringify(refused)}`)
      const head = yield* log.head(id)
      yield* expect("conflict", head.seq === 1 && head.revision === 1 && canonicalJson(head.state) === "{}", "a refused commit wrote something")
    })),
    check("a commit after its notAfter is refused by the storage clock and writes nothing", "expiry", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const head = yield* log.head(id)
      const refused = yield* Effect.flip(Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.some(head.now - 60_000), events: [draft("late", {})], state: Option.none() }) }))
      yield* expect("expiry", refused._tag === "LeaseExpired", `refused with ${refused._tag}`)
      const inTime = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.some(head.now + 600_000), events: [draft("on-time", {})], state: Option.none() }) })
      yield* expect("expiry", inTime.revision === 1 && (yield* log.head(id)).seq === 1, "a commit in time was refused or the late one was written")
    })),
    check("of concurrent commits against one revision, exactly one wins", "race", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const attempts = yield* Effect.forEach([0, 1, 2, 3, 4, 5, 6, 7], (n) =>
        Effect.result(Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [draft("attempt", { n })], state: Option.some({ winner: n }) }) })), { concurrency: "unbounded" })
      const won = attempts.filter((attempt) => attempt._tag === "Success")
      const refused = attempts.filter((attempt) => attempt._tag === "Failure" && attempt.failure._tag === "RevisionConflict")
      yield* expect("race", won.length === 1 && refused.length === 7, `${won.length} won, ${refused.length} refused`)
      const head = yield* log.head(id)
      const events = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      yield* expect("race", head.revision === 1 && events.length === 1 && canonicalJson(head.state) === canonicalJson({ winner: events[0]?.data.n }), "the winner's state and event disagree")
    })),
    check("event data and state come back equal, whatever key order the store keeps", "json", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [draft("rich", rich)], state: Option.some(rich) }) })
      const [event] = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      yield* expect("json", event !== undefined && canonicalJson(event.data) === canonicalJson(rich), `data came back as ${JSON.stringify(event?.data)}`)
      yield* expect("json", canonicalJson((yield* log.head(id)).state) === canonicalJson(rich), "the state came back different")
    })),
    check("event data with an undefined field commits and reads back without it", "json-unset", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const committed = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("unset", withUnset({ kept: 1, nested: withUnset({ list: [1] }) }))] }) })
      const read = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      const expected = canonicalJson({ kept: 1, nested: { list: [1] } })
      const dropped = (events: ReadonlyArray<{ readonly data: JsonObject }>) =>
        events.length === 1 && canonicalJson(events[0]!.data) === expected && !keepsUnset(events[0]!.data)
      yield* expect("json-unset", dropped(committed.events), "the commit did not return the data without its undefined fields")
      yield* expect("json-unset", dropped(read), "a read did not return the data without its undefined fields")
    })),
    check("an event holding MEDIA_LIMITS.requestChars of base64 (a message's images at their limit) comes back whole", "large", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      const each = MEDIA_LIMITS.requestChars / MEDIA_LIMITS.attachments
      const large: JsonObject = {
        userMessage: {
          text: "large",
          attachments: Array.from({ length: MEDIA_LIMITS.attachments }, (_, index) => ({ type: "media", data: `${"QUJD".repeat(each / 4 - 1)}${String(index).padStart(4, "0")}` })),
        },
      }
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("large", large, Option.some(1))] }) })
      const [event] = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      const chars = (data: JsonObject | undefined) => canonicalJson(data ?? {}).length
      yield* expect("large", event !== undefined && chars(event.data) === chars(large) && canonicalJson(event.data) === canonicalJson(large),
        `an event of ${chars(large)} characters came back with ${chars(event?.data)}`)
    })),
    check("input and returned JSON are detached from stored heads and events", "json-isolation", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const header = headerOf(id, owner)
      const expectedMeta = canonicalJson(header.meta)
      const created = yield* log.create({ header: header, state: {} })
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
      const committed = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [draft("fact", value)], state: Option.some(value) }) })
      value.nested.text = "input"
      value.list[0] = "input"
      const head = yield* log.head(id)
      const listed = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })
      const events = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      change(head.header.meta, "output")
      change(head.state, "output")
      listed.forEach((entry) => { change(entry.header.meta, "output"); change(entry.state, "output") })
      committed.events.forEach((event) => change(event.data, "output"))
      events.forEach((event) => change(event.data, "output"))
      const again = yield* log.head(id)
      const reread = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })
      yield* expect("json-isolation", again.revision === 1 && again.seq === 1, "mutating a returned value moved the head")
      yield* expect("json-isolation", canonicalJson(again.header.meta) === expectedMeta, "input, create, head or list metadata changed the stored header")
      yield* expect("json-isolation", canonicalJson(again.state) === expected, "input, head or list state changed the stored state")
      yield* expect("json-isolation", reread.length === 1 && canonicalJson(reread[0]!.data) === expected, "input, commit or read data changed the stored event")
    })),
    check("reads return events after a position, ascending, filtered by kind and limited", "read", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: ["a", "b", "a", "c", "a"].map((kind, n) => draft(kind, { n })) }) })
      const seqs = (events: ReadonlyArray<{ readonly seq: number }>) => events.map((event) => event.seq).join()
      yield* expect("read", seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 2, limit: Option.none(), kinds: [] }) })) === "3,4,5", "after is not exclusive")
      yield* expect("read", seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: ["a"] }) })) === "1,3,5", "kinds do not filter")
      yield* expect("read", seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 1, limit: Option.some(2), kinds: ["a", "c"] }) })) === "3,4", "limit does not apply after the filter")
      yield* expect("read", (yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 5, limit: Option.none(), kinds: [] }) })).length === 0, "reading past the end returned events")
    })),
    check("an inclusive read ceiling selects the visible prefix before kind filtering and limits", "read-through", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: ["a", "b", "a", "c", "a"].map((kind, n) => draft(kind, { n })) }) })
      const seqs = (events: ReadonlyArray<{ readonly seq: number }>) => events.map((event) => event.seq).join()
      yield* expect("read-through", seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, through: 3, limit: Option.none(), kinds: [] }) })) === "1,2,3", "the inclusive ceiling was ignored")
      yield* expect("read-through", seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 1, through: 3, limit: Option.some(2), kinds: ["a", "c"] }) })) === "3", "kind filtering or limiting leaked a later event")
      yield* expect("read-through", (yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 3, through: 3, limit: Option.none(), kinds: [] }) })).length === 0, "a closed range returned events")
      yield* expect("read-through", (yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, through: 0, limit: Option.none(), kinds: [] }) })).length === 0, "an empty prefix returned events")
    })),
    check("a read from the end keeps the newest matches of its kinds, below its ceiling, ascending, across commits", "read-latest", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      // Three commits, so a backend that walks its commits backwards crosses them: a b a | c a | b.
      yield* Effect.forEach([["a", "b", "a"], ["c", "a"], ["b"]], (kinds, revision) =>
        Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: revision, ...noEvents, events: kinds.map((kind, n) => draft(kind, { revision, n })) }) }), { concurrency: 1, discard: true })
      const seqs = (events: ReadonlyArray<{ readonly seq: number }>) => events.map((event) => event.seq).join()
      const latest = (query: { readonly after?: number; readonly through?: number; readonly limit?: number; readonly kinds?: ReadonlyArray<string> }) =>
        Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: query.after ?? 0, limit: Option.fromNullishOr(query.limit), kinds: query.kinds ?? [], from: "end", ...(query.through === undefined ? {} : { through: query.through }) }) }).pipe(Effect.map(seqs))
      yield* expect("read-latest", (yield* latest({ limit: 2 })) === "5,6", "the newest events were not returned, or not ascending")
      yield* expect("read-latest", (yield* latest({ limit: 2, kinds: ["a"] })) === "3,5", "the newest events of a kind were not returned")
      yield* expect("read-latest", (yield* latest({ limit: 2, kinds: ["a", "c"] })) === "4,5", "the limit applied before the kinds filter")
      yield* expect("read-latest", (yield* latest({ limit: 3, kinds: ["a"] })) === "1,3,5", "the newest matches did not span the commits")
      yield* expect("read-latest", (yield* latest({ kinds: ["a"] })) === "1,3,5", "without a limit, not every match was returned")
      yield* expect("read-latest", (yield* latest({ through: 4, limit: 1, kinds: ["a"] })) === "3", "the inclusive ceiling was ignored")
      yield* expect("read-latest", (yield* latest({ after: 3, limit: 5, kinds: ["a"] })) === "5", "events at or before after were returned")
      yield* expect("read-latest", (yield* latest({ limit: 0 })) === "", "a zero limit returned events")
      const fromStart = seqs(yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.some(2), kinds: ["a"], from: "start" }) }))
      yield* expect("read-latest", fromStart === "1,3", "from: start did not read as an omitted from")
    })),
    check("a key-only read (media: references) selects the same events with the same data", "read-references", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: ["a", "b", "a"].map((kind, n) => draft(kind, { n, nested: { kept: [n, "value"] } })) }) })
      const rows = (events: ReadonlyArray<{ readonly seq: number; readonly kind: string; readonly data: unknown }>) => JSON.stringify(events.map((event) => [event.seq, event.kind, event.data]))
      const queries = [{ after: 0, limit: Option.none<number>(), kinds: [] }, { after: 1, through: 3, limit: Option.some(1), kinds: ["a"] }, { after: 0, limit: Option.some(1), kinds: ["a"], from: "end" as const }]
      yield* Effect.forEach(queries, (query) => Effect.gen(function* () {
        const hydrated = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, query) })
        const keyed = yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { ...query, media: "references" }) })
        yield* expect("read-references", hydrated.length > 0 && rows(keyed) === rows(hydrated), "a key-only read changed which events or what data were returned")
      }), { concurrency: 1, discard: true })
    })),
    check("a listing holds the owner's top-level sessions, newest first, before the cursor", "list", (owner) => Effect.gen(function* () {
      const [first, second, third] = [yield* freshId, yield* freshId, yield* freshId]
      yield* log.create({ header: headerOf(first, owner), state: {} })
      yield* log.create({ header: headerOf(second, owner), state: {} })
      yield* log.create({ header: headerOf(third, owner), state: {} })
      yield* log.create({ header: headerOf(yield* freshId, `${owner}-other`), state: {} })
      yield* log.create({ header: headerOf(yield* freshId, owner, Option.some({ ...sessionRef(yield* log.head(first)), through: 0, turnAtFork: 0 })), state: {} })
      yield* Effect.sleep("5 millis")
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(second); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("touch", {})] }) })
      const listed = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })
      yield* expect("list", listed.length === 3 && listed[0]?.header.id === second, `listed ${listed.map((head) => head.header.id).join()}`)
      yield* expect("list", listed.every((head, index) => index === 0 || (listed[index - 1]!.updatedAt > head.updatedAt
        || (listed[index - 1]!.updatedAt === head.updatedAt && listed[index - 1]!.header.id > head.header.id))), "the listing is not newest first, then by id")
      const cursor = listed[0]!
      const rest = yield* log.list({ owner, limit: 10, before: Option.some({ updatedAt: cursor.updatedAt, id: cursor.header.id }), parent: Option.none() })
      yield* expect("list", rest.length === 2 && rest.every((head) => head.header.id !== second), "the cursor is not exclusive")
      yield* expect("list", (yield* log.list({ owner, limit: 1, before: Option.none(), parent: Option.none() })).length === 1, "the limit is ignored")
      const children = yield* log.list({ owner, limit: 10, before: Option.none(), parent: Option.some(sessionRef(yield* log.head(first))) })
      yield* expect("list", children.length === 1 && Option.exists(children[0]!.header.parent, (parent) => parent.id === first), "children are not listed under their parent")
    })),
    check("a child needs its parent, and removing a session removes its events and children", "lineage", (owner) => Effect.gen(function* () {
      const [parent, child, grandchild, orphan] = [yield* freshId, yield* freshId, yield* freshId, yield* freshId]
      const lost = yield* Effect.flip(log.create({ header: headerOf(orphan, owner, Option.some({ id: yield* freshId, owner, incarnation: SessionIncarnation.make("missing"), through: 0, turnAtFork: 0 })), state: {} }))
      yield* expect("lineage", lost._tag === "SessionMissing", `a child of a missing parent gave ${lost._tag}`)
      yield* log.create({ header: headerOf(parent, owner), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(parent); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, ...noEvents, events: [draft("a", {})] }) })
      const forked = yield* log.create({ header: headerOf(child, owner, Option.some({ ...sessionRef(yield* log.head(parent)), through: 1, turnAtFork: 1 })), state: {} })
      yield* expect("lineage", Option.exists(forked.header.parent, (lineage) => lineage.id === parent && lineage.through === 1 && lineage.turnAtFork === 1), "the lineage changed")
      yield* log.create({ header: headerOf(grandchild, owner, Option.some({ ...sessionRef(yield* log.head(child)), through: 0, turnAtFork: 1 })), state: {} })
      const [parentRef, childRef, grandchildRef] = [sessionRef(yield* log.head(parent)), sessionRef(yield* log.head(child)), sessionRef(yield* log.head(grandchild))]
      // A child belongs to its parent's owner: another owner's fork of this session is refused and leaves nothing.
      const foreign = yield* freshId
      const crossed = yield* Effect.flip(log.create({ header: headerOf(foreign, `${owner}-other`, Option.some({ ...parentRef, through: 0, turnAtFork: 0 })), state: {} }))
      yield* expect("lineage", crossed._tag === "SessionMissing", `a child of another owner's session gave ${crossed._tag}`)
      yield* expect("lineage", (yield* Effect.flip(log.head(foreign)))._tag === "SessionMissing", "another owner's refused child is there")
      const crossedListed = yield* log.list({ owner: `${owner}-other`, limit: 10, before: Option.none(), parent: Option.some(parentRef) })
      yield* expect("lineage", crossedListed.length === 0, "another owner's refused child is listed under the parent")
      yield* log.remove(parentRef)
      const gone = yield* Effect.forEach([parent, child, grandchild], (id) => Effect.flip(log.head(id)), { concurrency: 1 })
      yield* expect("lineage", gone.every((error) => error._tag === "SessionMissing"), "a removed session or child is still there")
      // The references read before the removal, used directly: no head lookup stands in for the call.
      const everything = { after: 0, limit: Option.none<number>(), kinds: [] }
      const reads = yield* Effect.forEach([parentRef, childRef, grandchildRef], (reference) => Effect.flip(log.read(reference, everything)), { concurrency: 1 })
      yield* expect("lineage", reads.every((error) => error._tag === "SessionMissing"), `a removed session or a child removed with it still reads: ${reads.map((error) => error._tag).join()}`)
      const written = yield* Effect.flip(log.commit(childRef, { expect: 0, ...noEvents, events: [draft("late", {})] }))
      yield* expect("lineage", written._tag === "SessionMissing", `a commit to a child removed with its parent gave ${written._tag}`)
      const again = yield* Effect.forEach([parentRef, childRef], (reference) => Effect.flip(log.remove(reference)), { concurrency: 1 })
      yield* expect("lineage", again.every((error) => error._tag === "SessionMissing"), `removing a removed session again gave ${again.map((error) => error._tag).join()}`)
    })),
    check("a missing session is SessionMissing to every operation", "missing", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const reference = { id, owner, incarnation: SessionIncarnation.make("missing") }
      const errors = [yield* Effect.flip(log.head(id)), yield* Effect.flip(log.read(reference, { after: 0, limit: Option.none(), kinds: [] })),
        yield* Effect.flip(log.commit(reference, { expect: 0, ...noEvents, events: [draft("a", {})] })), yield* Effect.flip(log.remove(reference))]
      yield* expect("missing", errors.every((error) => error._tag === "SessionMissing"), `got ${errors.map((error) => error._tag).join()}`)
    })),
    check("a session removed and created again under its id is another incarnation: a commit naming the one before is SessionMissing and writes nothing, whatever its revision", "incarnation", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const first = yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* expect("incarnation", (yield* log.head(id)).incarnation === first.incarnation, "the head's incarnation is not the one its create gave")
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ ...{ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, incarnation: first.incarnation }, { expect: 0, ...noEvents, events: [draft("before", {})] }) })
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.remove({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }) })
      const again = yield* log.create({ header: headerOf(id, owner), state: {} })
      yield* expect("incarnation", again.incarnation !== first.incarnation, "a session created again kept the incarnation of the one removed")
      // The new incarnation reaches the revision the removed one was at: only the incarnation tells them apart.
      yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ ...{ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, incarnation: again.incarnation }, { expect: 0, ...noEvents, events: [draft("after", {})] }) })
      const stale = yield* Effect.flip(Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.commit({ ...{ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, incarnation: first.incarnation }, { expect: 1, notAfter: Option.none(), events: [draft("stale", {})], state: Option.some({ stale: true }) }) }))
      yield* expect("incarnation", stale._tag === "SessionMissing", `a commit naming the removed incarnation gave ${stale._tag}`)
      const child = yield* Effect.flip(log.create({ header: headerOf(yield* freshId, owner, Option.some({ ...sessionRef(first), through: 0, turnAtFork: 0 })), state: {} }))
      yield* expect("incarnation", child._tag === "SessionMissing", "a stale parent reference attached a child to the replacement")
      const staleReference = sessionRef(first)
      const wrongOwner = { ...sessionRef(again), owner: `${owner}-other` }
      const refused = [yield* Effect.flip(log.read(staleReference, { after: 0, limit: Option.none(), kinds: [] })),
        yield* Effect.flip(log.read(wrongOwner, { after: 0, limit: Option.none(), kinds: [] })), yield* Effect.flip(log.remove(staleReference)),
        yield* Effect.flip(log.remove(wrongOwner)), yield* Effect.flip(log.commit(wrongOwner, { expect: 1, ...noEvents, events: [] }))]
      yield* expect("incarnation", refused.every((error) => error._tag === "SessionMissing"), "a stale or wrong-owner reference reached the replacement session")
      const head = yield* log.head(id)
      const kinds = (yield* Effect.gen(function* () { const sessionHead = yield* log.head(id); return yield* log.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) })).map((event) => event.kind).join()
      yield* expect("incarnation", head.revision === 1 && head.incarnation === again.incarnation && canonicalJson(head.state) === "{}" && kinds === "after",
        `the commit naming the removed incarnation wrote: revision ${head.revision}, events ${kinds}`)
    })),
  ]
}
