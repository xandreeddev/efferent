import { expect, test } from "bun:test"
import { Effect, Option, Ref, Schema } from "effect"
import { MediaHash, MediaStoreBytes, MediaStoreError } from "../domain/media-store.entity.js"
import { mediaHashOf } from "../domain/media-store.entity.functions.js"
import { MediaStore } from "../ports/media-store.port.js"
import { mediaStoreConformance } from "./media-store.conformance.js"
import type { MediaStoreSubject } from "./media-store.conformance.js"

const failedChecks = (subject: MediaStoreSubject) => Effect.runPromise(Effect.forEach(mediaStoreConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((checks) => checks.flat())))
const ids = ["hash", "roundtrip", "idempotent", "missing", "input-copy", "output-copy", "bounds"]
const unavailable = () => Effect.fail(new MediaStoreError({ reason: "Unavailable", message: "backend unavailable" }))

const careless = (fault: "input-alias" | "output-alias" | "constant-hash" | "missing-empty" | "wrong-bytes" | "no-op"): MediaStoreSubject => ({
  open: () => Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<MediaHash, Uint8Array>>(new Map())
    return MediaStore.of({
      put: (bytes) => Schema.decodeUnknownEffect(MediaStoreBytes)(bytes).pipe(
        Effect.mapError((cause) => new MediaStoreError({ reason: "Invalid", message: "invalid bytes", cause })),
        Effect.flatMap((bytes) => {
          const hash = fault === "constant-hash" ? MediaHash.make("1".repeat(64)) : mediaHashOf(bytes)
          return Ref.update(state, (values) => fault === "no-op" ? values : new Map([...values, [hash, fault === "input-alias" ? bytes : new Uint8Array(bytes)]])).pipe(Effect.as(hash))
        }),
      ),
      get: (hash) => Ref.get(state).pipe(Effect.map((values) => {
        const found = values.get(hash)
        return found === undefined
          ? fault === "missing-empty" ? Option.some(new Uint8Array()) : Option.none()
          : Option.some(fault === "output-alias" ? found : fault === "wrong-bytes" ? new Uint8Array([9]) : new Uint8Array(found))
      })),
    })
  }),
})

test("the media-store kit lists all seven bounded immutable-byte promises", async () => {
  expect(mediaStoreConformance({ open: unavailable })).toHaveLength(7)
  expect(await failedChecks({ open: () => Effect.succeed(MediaStore.of({ put: unavailable, get: unavailable })) })).toEqual(ids)
})

test.each([
  { fault: "constant-hash" as const, check: "hash" },
  { fault: "no-op" as const, check: "roundtrip" },
  { fault: "input-alias" as const, check: "input-copy" },
  { fault: "output-alias" as const, check: "output-copy" },
  { fault: "missing-empty" as const, check: "missing" },
  { fault: "wrong-bytes" as const, check: "roundtrip" },
])("the kit catches $fault", async ({ fault, check }) => {
  expect(await failedChecks(careless(fault))).toContain(check)
})
