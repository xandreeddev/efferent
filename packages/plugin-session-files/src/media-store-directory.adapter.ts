import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Effect, Layer, Match, Option, Result, Schema } from "effect"
import { errorCodeOf, MEDIA_LIMITS, MediaHash, mediaHashOf, MediaStore, MediaStoreBytes, MediaStoreError } from "@xandreed/core"
import type { FilesIo } from "./files-io.adapter.js"
import { nodeFilesIo } from "./files-io.adapter.js"
import { makeBoundedFilesCall } from "./bounded-call.adapter.js"
import { MEDIA_DIRECTORY_LAYOUT, MediaDirectoryMarker } from "./media-store-directory.entity.js"
import { sessionFilesDefaults } from "./session-files.entity.js"
import type { FileStoreIo, FileStoreStalled } from "./session-files.entity.js"

/** The directory adapter's bounded IO and fault-injection seam. @public */
export interface MediaStoreDirectoryOptions {
  readonly io?: FilesIo
  readonly stallMs?: number
}

type Failed = FileStoreIo | FileStoreStalled
const missing = (error: Failed): boolean => error._tag === "FileStoreIo" && Option.contains(errorCodeOf(error.cause), "ENOENT")
const unavailable = (error: Failed): MediaStoreError => Match.valueTags(error, {
  FileStoreIo: ({ cause }) => new MediaStoreError({ reason: "Unavailable", message: "The media directory is unavailable.", cause }),
  FileStoreStalled: (cause) => new MediaStoreError({ reason: "Unavailable", message: "The media directory did not answer within its deadline.", cause }),
})
const corrupt = () => new MediaStoreError({ reason: "Corrupt", message: "The stored media does not match its content key." })
const equal = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index])
const stallBound = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const makeDirectory = Effect.fnUntraced(function* (root: string, options?: MediaStoreDirectoryOptions) {
  const io = options?.io ?? nodeFilesIo
  const stallMs = yield* Schema.decodeUnknownEffect(stallBound)(options?.stallMs ?? sessionFilesDefaults.stallMs).pipe(
    Effect.mapError(cause => new MediaStoreError({ reason: "Invalid", message: "The media directory deadline is invalid.", cause })),
  )
  const call = yield* makeBoundedFilesCall(stallMs)
  const blobs = join(root, "blobs")
  const temporary = join(root, "tmp")
  const marker = join(root, "media-store.json")
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const clean = (path: string) => call("unlink", path, () => io.unlink(path)).pipe(Effect.ignore({ log: "Debug", message: "A temporary media file was left for later cleanup." }))
  const sync = (path: string) => call("sync", path, () => io.syncDirectory(path)).pipe(Effect.ignore({ log: "Debug", message: "The media directory could not synchronize its directory entries." }))
  const read = (path: string, max: number) => call("read", path, () => io.readStart(path, max + 1)).pipe(
    Effect.map(Option.some), Effect.catchIf(missing, () => Effect.succeed(Option.none<Uint8Array>())), Effect.mapError(unavailable),
  )
  const markerAt = Effect.gen(function* () {
    const found = yield* read(marker, 1024)
    return yield* Option.match(found, {
      onNone: () => Effect.succeed(false),
      onSome: bytes => Effect.gen(function* () {
        if (bytes.length > 1024) return yield* Effect.fail(new MediaStoreError({ reason: "Corrupt", message: "The media directory marker is invalid." }))
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MediaDirectoryMarker))(decoder.decode(bytes)).pipe(
          Effect.mapError(cause => new MediaStoreError({ reason: "Corrupt", message: "The media directory marker is invalid.", cause })),
        )
        if (decoded.layout !== MEDIA_DIRECTORY_LAYOUT) return yield* Effect.fail(new MediaStoreError({ reason: "Unavailable", message: "The media directory layout is not supported." }))
        return true
      }),
    })
  })
  yield* Effect.forEach([root, blobs, temporary], path => call("mkdir", path, () => io.mkdir(path)), { concurrency: 1, discard: true }).pipe(Effect.mapError(unavailable))
  if (!(yield* markerAt)) {
    const path = join(temporary, `marker.${randomUUID()}`)
    yield* Effect.gen(function* () {
      yield* call("create", path, () => io.create(path, encoder.encode(`${JSON.stringify({ layout: MEDIA_DIRECTORY_LAYOUT, algorithm: "sha256" })}\n`))).pipe(Effect.mapError(unavailable))
      yield* call("link", marker, () => io.link(path, marker)).pipe(
        Effect.catch(error => markerAt.pipe(
          Effect.catchIf(failure => failure.reason === "Unavailable", () => Effect.fail(unavailable(error))),
          Effect.flatMap(exists => exists ? Effect.void : Effect.fail(unavailable(error))),
        )),
        Effect.ensuring(clean(path).pipe(Effect.interruptible)),
      )
      yield* sync(root)
    })
  }
  const blobAt = (hash: MediaHash) => read(join(blobs, `${hash}.bin`), MEDIA_LIMITS.imageBytes).pipe(Effect.flatMap(found => Option.match(found, {
    onNone: () => Effect.succeed(Option.none<Uint8Array>()),
    onSome: raw => {
      const bytes = new Uint8Array(raw)
      return bytes.length > 0 && bytes.length <= MEDIA_LIMITS.imageBytes && mediaHashOf(bytes) === hash
        ? Effect.succeed(Option.some(bytes)) : Effect.fail(corrupt())
    },
  })))
  const checkHash = (hash: MediaHash) => Schema.decodeUnknownEffect(MediaHash)(hash).pipe(Effect.mapError(cause => new MediaStoreError({ reason: "Invalid", message: "The media content key is invalid.", cause })))
  return MediaStore.of({
    get: Effect.fn("media_store.get")(function* (key) {
      return yield* blobAt(yield* checkHash(key))
    }),
    put: Effect.fn("media_store.put")(function* (input) {
      const decoded = Schema.decodeUnknownResult(MediaStoreBytes)(input)
      if (Result.isFailure(decoded)) return yield* Effect.fail(new MediaStoreError({ reason: "Invalid", message: "The media bytes are outside the store's bounds.", cause: decoded.failure }))
      const bytes = new Uint8Array(decoded.success)
      const checked = Schema.decodeUnknownResult(MediaStoreBytes)(bytes)
      if (Result.isFailure(checked)) return yield* Effect.fail(new MediaStoreError({ reason: "Invalid", message: "The media bytes are outside the store's bounds.", cause: checked.failure }))
      const hash = mediaHashOf(bytes)
      const existing = yield* blobAt(hash)
      if (Option.isSome(existing)) {
        if (!equal(existing.value, bytes)) return yield* Effect.fail(corrupt())
        return hash
      }
      const path = join(temporary, `${hash}.${randomUUID()}.tmp`)
      const final = join(blobs, `${hash}.bin`)
      yield* Effect.gen(function* () {
        yield* call("create", path, () => io.create(path, bytes)).pipe(Effect.mapError(unavailable))
        yield* call("link", final, () => io.link(path, final)).pipe(Effect.catch(error => blobAt(hash).pipe(
          Effect.catchIf(failure => failure.reason === "Unavailable", () => Effect.fail(unavailable(error))),
          Effect.flatMap(found => Option.isSome(found) && equal(found.value, bytes) ? Effect.void : Effect.fail(unavailable(error))),
        )), Effect.ensuring(clean(path).pipe(Effect.interruptible)))
        yield* sync(blobs)
      })
      return hash
    }),
  })
})

/**
 * Immutable SHA-256 media blobs, published by exclusive hard link after file sync.
 * The independent root retains orphans; session removal never deletes blobs.
 * @public
 */
export const MediaStoreDirectoryLive = (root: string, options?: MediaStoreDirectoryOptions) => Layer.effect(MediaStore, makeDirectory(root, options))
