import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Option, Order, Ref } from "effect"
import type { ConformanceCheck } from "@xandreed/core"
import { inMemoryMedia } from "../../plugins/media-in-memory/in-memory-media.adapter.js"
import { MediaRefused } from "./media.entity.js"
import { mediaHashOf } from "./media.entity.functions.js"
import { mediaStoreConformance } from "./media.conformance.js"
import type { MediaStoreSubject } from "./media.conformance.js"
import { MediaStore } from "./media.port.js"

/*
 * The media kit's own test: it has the checks its doc comment lists, and each careless store written here fails the
 * check of what it is careless about and no other.
 */

type MediaStoreShape = Context.Service.Shape<typeof MediaStore>

const IDS = ["again", "apart", "bounds", "hash", "input-copy", "key", "missing", "output-copy"]
const BOUND = 64

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => (result._tag === "Failure" ? [result.failure.check === check.id ? check.id : `${check.id} reported as ${result.failure.check}`] : []))), { concurrency: 1 }))
    .then((failed) => Arr.sort(failed.flat(), Order.String))

/** The stock store in memory, at a small bound. */
const stock = Effect.map(Layer.build(inMemoryMedia({ maxBytes: BOUND })), (services) => Context.get(services, MediaStore))

/** A store over a map the test writes by hand, with one way of being careless. */
const careless = (fault: "none" | "hash" | "again" | "apart" | "input-copy" | "output-copy" | "missing" | "bounds" | "key"): MediaStoreSubject => ({
  open: Effect.gen(function* () {
    const kept = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map())
    const latest = yield* Ref.make<Option.Option<Uint8Array>>(Option.none())
    const store: MediaStoreShape = {
      maxBytes: BOUND,
      put: (bytes) => Effect.gen(function* () {
        if (bytes.length === 0) return yield* Effect.fail(new MediaRefused({ reason: "empty", message: "none" }))
        if (bytes.length > BOUND && fault !== "bounds") return yield* Effect.fail(new MediaRefused({ reason: "size", message: "too many" }))
        // Careless about the key: the hash of the bytes and one more.
        const hash = fault === "hash" ? mediaHashOf(new Uint8Array([...bytes, 0])) : mediaHashOf(bytes)
        if (fault === "again" && (yield* Ref.get(kept)).has(hash)) return yield* Effect.fail(new MediaRefused({ reason: "bytes", message: "already kept" }))
        // Careless about the copy: the caller's own buffer kept.
        const held = fault === "input-copy" ? bytes : new Uint8Array(bytes)
        yield* Ref.update(kept, (now) => new Map([...now, [hash, held]]))
        yield* Ref.set(latest, Option.some(held))
        return hash
      }),
      get: (hash) => Effect.gen(function* () {
        if (!/^[0-9a-f]{64}$/.test(hash)) return fault === "key" ? Option.none() : yield* Effect.fail(new MediaRefused({ reason: "key", message: "no key" }))
        const found = (yield* Ref.get(kept)).get(hash)
        // Careless about absence: something made up for a key nothing was put under.
        if (found === undefined) return fault === "missing" ? Option.some(new Uint8Array([1])) : Option.none()
        // Careless about which bytes: those of the latest put, whatever the key.
        const given = fault === "apart" ? Option.getOrElse(yield* Ref.get(latest), () => found) : found
        // Careless about the copy: the kept buffer itself.
        return Option.some(fault === "output-copy" ? given : new Uint8Array(given))
      }),
    }
    return store
  }),
})

describe("the media kit", () => {
  test("has the checks its doc comment lists, and the stock store in memory passes them, at a small bound and at the default", async () => {
    expect(mediaStoreConformance({ open: stock }).map((check) => check.id).toSorted()).toEqual(IDS)
    expect(await failedChecks(mediaStoreConformance({ open: stock }))).toEqual([])
    const atDefault = Effect.map(Layer.build(inMemoryMedia()), (services) => Context.get(services, MediaStore))
    expect(await failedChecks(mediaStoreConformance({ open: atDefault }))).toEqual([])
  })

  test("a store that fails every call fails every check", async () => {
    const down = MediaStore.of({ maxBytes: BOUND, put: () => Effect.fail(new MediaRefused({ reason: "bytes", message: "down" })), get: () => Effect.fail(new MediaRefused({ reason: "bytes", message: "down" })) })
    expect(await failedChecks(mediaStoreConformance({ open: Effect.succeed(down) }))).toEqual(IDS)
  })

  for (const fault of ["hash", "again", "apart", "input-copy", "output-copy", "missing", "bounds", "key"] as const) {
    test(`a store careless about ${fault} fails that check and no other`, async () => {
      expect(await failedChecks(mediaStoreConformance(careless(fault)))).toEqual([fault])
    })
  }

  test("the same hand-written store with no fault passes every check: each careless one differs from it by its fault alone", async () => {
    expect(await failedChecks(mediaStoreConformance(careless("none")))).toEqual([])
  })
})
