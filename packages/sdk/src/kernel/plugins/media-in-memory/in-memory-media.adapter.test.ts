import { describe, expect, test } from "bun:test"
import { Cause, Context, Effect, Layer, Option } from "effect"
import { MediaStore } from "../../contracts/media/media.port.js"
import { mediaHashOf } from "../../contracts/media/media.entity.functions.js"
import { inMemoryMedia } from "./in-memory-media.adapter.js"

const open = (maxBytes?: number) => Effect.map(Layer.build(inMemoryMedia(maxBytes === undefined ? {} : { maxBytes })), (services) => Context.get(services, MediaStore))

describe("a media store in memory", () => {
  test("keeps equal and different bytes put at once, each under its own key", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open()
      const values = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([1, 2, 3])]
      const keys = yield* Effect.forEach(values, store.put, { concurrency: 3 })
      const found = yield* Effect.forEach(keys, store.get, { concurrency: 3 })
      return { keys, found: found.map((one) => Option.map(one, (bytes) => Array.from(bytes))) }
    })))
    expect(result.keys).toEqual([mediaHashOf(new Uint8Array([1, 2, 3])), mediaHashOf(new Uint8Array([4, 5, 6])), mediaHashOf(new Uint8Array([1, 2, 3]))])
    expect(result.found).toEqual([Option.some([1, 2, 3]), Option.some([4, 5, 6]), Option.some([1, 2, 3])])
  })

  test("each build is a store of its own", async () => {
    const found = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = yield* open()
      const other = yield* open()
      return yield* other.get(yield* first.put(new Uint8Array([1])))
    })))
    expect(found).toEqual(Option.none())
  })

  test("says its bound, and a bound that is no whole number of 1 or more dies where the layer is built", async () => {
    expect(await Effect.runPromise(Effect.scoped(Effect.map(open(), (store) => store.maxBytes)))).toBe(3_932_160)
    for (const maxBytes of [0, 1.5, -1]) {
      const exit = await Effect.runPromiseExit(Effect.scoped(open(maxBytes)))
      expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "built").toContain(`inMemoryMedia: maxBytes must be a whole number of at least 1, not ${maxBytes}`)
    }
  })
})
