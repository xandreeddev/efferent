import { expect, test } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { ConversationId, SessionMissing, Sessions } from "@xandreed/core"
import type { SessionAddress, SessionLogEvent } from "@xandreed/core"
import { JournalTail } from "./ports/render.port.js"
import { SessionsJournalTailLive } from "./render-tail.sessions.adapter.js"

const id = ConversationId.make("00000000-0000-4000-8000-00000000fee0")
const stored: ReadonlyArray<SessionLogEvent> = [
  { session: id, seq: 1, turn: Option.some(1), kind: "turn.started", at: 0, data: { runId: "r" } },
  { session: id, seq: 2, turn: Option.some(1), kind: "canvas.planned", at: 0, data: { page: "p" } },
]

/** Sessions that hold one session of `owner`; everything else is unused by the tail. */
const sessionsOf = (owner: string, asked: Array<SessionAddress>) => {
  const unused = () => Effect.die("unused")
  return Sessions.of({
    create: unused, fork: unused, get: unused, list: unused, remove: unused, lookup: unused, transact: unused,
    cancel: unused, begin: unused, deliver: unused, drain: unused,
    read: (address, query) => {
      asked.push(address)
      return address.owner === owner && address.id === id
        ? Effect.succeed(stored.filter((event) => event.seq > (query?.after ?? 0)))
        : Effect.fail(new SessionMissing({ session: address.id }))
    },
    changes: () => Stream.make(undefined),
  })
}

const tailOver = (owner: string, asked: Array<SessionAddress>) =>
  Effect.runSync(Effect.service(JournalTail).pipe(Effect.provide(SessionsJournalTailLive().pipe(Layer.provide(Layer.succeed(Sessions, sessionsOf(owner, asked)))))))

test("a session's events are the feed's records, read as the feed's principal", async () => {
  const asked: Array<SessionAddress> = []
  const tail = tailOver("owner-1", asked)
  const records = await Effect.runPromise(tail.read({ threadId: id, principalId: "owner-1" }, 1))
  expect(records).toEqual([{ sequence: 2, kind: "canvas.planned", data: { page: "p" }, turn: 1 }])
  expect(asked).toEqual([{ id, owner: "owner-1" }])
})

test("another owner, or a name that is not a session, reads nothing", async () => {
  const tail = tailOver("owner-1", [])
  const stranger = await Effect.runPromise(Effect.flip(tail.read({ threadId: id, principalId: "someone-else" }, 0)))
  const invalid = await Effect.runPromise(Effect.flip(tail.read({ threadId: "not-a-session", principalId: "owner-1" }, 0)))
  expect([stranger.code, invalid.code]).toEqual(["forbidden", "invalid"])
})

test("the session's commits wake the feed", async () => {
  const tail = tailOver("owner-1", [])
  const woken = await Effect.runPromise(Stream.runCount(Option.getOrThrow(Option.fromNullishOr(tail.changes))({ threadId: id, principalId: "owner-1" })))
  expect(woken).toBe(1)
})
