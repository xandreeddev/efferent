import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import {
  ConversationId, mediaFromBytes, mediaHashOf, MediaStore, RunId, SessionLog, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UNAVAILABLE_MEDIA_DATA, UserMessage, withMediaStore,
} from "@xandreed/core"
import type { SessionAddress } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>
const completed = { reason: "completed" as const, failure: Option.none() }
const sessionsOver = (log: Log) => Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))
  .pipe(Effect.map((context) => Context.get(context, Sessions)))
const address: SessionAddress = { owner: "media-store-sessions", id: ConversationId.make("00000000-0000-4000-8000-00000000a501") }

/** A distinct PNG per seed: a valid header, then bytes no other seed shares. */
const png = (seed: number) => Uint8Array.from({ length: 4096 }, (_, index) => index < 33
  ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0, 0, 0, 0, 0][index]!
  : (index * 31 + seed * 7) & 0xff)

/** A media store that counts its reads and can lose a blob. */
const countingStore = () => {
  const blobs = new Map<string, Uint8Array>()
  const reads = { count: 0 }
  const service: MediaStore["Service"] = {
    put: (bytes) => Effect.sync(() => { const hash = mediaHashOf(bytes); blobs.set(hash, bytes.slice()); return hash }),
    get: (hash) => Effect.sync(() => { reads.count += 1; return Option.map(Option.fromNullishOr(blobs.get(hash)), (bytes) => bytes.slice()) }),
  }
  return { service, blobs, reads }
}

const scenario = Effect.scoped(Effect.gen(function* () {
  const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const store = countingStore()
  // cacheEntries 0: every hydration reads the store, so the counts below show which reads hydrate.
  const sessions = yield* sessionsOver(yield* withMediaStore(base, { cacheEntries: 0 }).pipe(Effect.provideService(MediaStore, store.service)))
  yield* sessions.create(address)
  const images = yield* Effect.forEach([1, 2, 3], (seed) => mediaFromBytes(png(seed), { name: `shot-${seed}.png` }), { concurrency: 1 })
  const asked = (index: number) => ({ _tag: "User" as const, key: `image-${index}`, runId: RunId.make(`image-run-${index}`), userMessage: new UserMessage({ text: `turn ${index}`, attachments: [images[index]!] }), command: {} })
  yield* Effect.forEach([0, 1, 2], (index) => Effect.scoped(sessions.begin(address, asked(index)).pipe(Effect.flatMap((writer) => writer.end(completed)))), { concurrency: 1, discard: true })
  store.reads.count = 0
  yield* Effect.scoped(sessions.begin(address, { _tag: "User", key: "text", runId: RunId.make("text-run"), userMessage: new UserMessage({ text: "next" }), command: {} }).pipe(Effect.flatMap((writer) => writer.end(completed))))
  const beginReads = store.reads.count
  // A retried begin compares its whole message with the stored turn's: that one row is read with its image.
  store.reads.count = 0
  const duplicate = yield* Effect.flip(Effect.scoped(sessions.begin(address, asked(1))))
  const duplicateReads = store.reads.count
  // The store loses one blob: later turns still begin, and the history reads with that image as its label.
  store.blobs.delete(mediaHashOf(png(2)))
  yield* Effect.scoped(sessions.begin(address, { _tag: "User", key: "after-loss", runId: RunId.make("after-loss-run"), userMessage: new UserMessage({ text: "still here" }), command: {} }).pipe(Effect.flatMap((writer) => writer.end(completed))))
  const history = yield* sessions.read(address, { kinds: ["turn.started"] })
  const attachments = history.map((event) => (event.data as { userMessage: { attachments?: ReadonlyArray<{ data: string; name?: string }> } }).userMessage.attachments?.[0])
  return { beginReads, duplicate, duplicateReads, attachments, images }
}))

test("a begin's turn lookups read no stored image, and a lost blob leaves the session usable", async () => {
  const result = await Effect.runPromise(scenario)
  expect(result.beginReads).toBe(0)
  expect(result.duplicate._tag).toBe("TurnDuplicate")
  expect(result.duplicateReads).toBe(1)
  expect(result.attachments.map((media) => media?.name)).toEqual(["shot-1.png", "shot-2.png", "shot-3.png", undefined, undefined])
  expect(result.attachments.map((media) => media?.data === UNAVAILABLE_MEDIA_DATA)).toEqual([false, true, false, false, false])
  expect(result.attachments[0]?.data).toBe(result.images[0]!.data)
})
