import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { MEDIA_LIMIT, MediaDamaged, MediaHash, MediaUnavailable } from "../../contracts/media/media.entity.js"
import { checkedBytes, checkedKey, isBound } from "../../contracts/media/media.entity.functions.js"
import { MediaStore } from "../../contracts/media/media.port.js"
import { MEDIA_FOLDERS, MEDIA_LAYOUT, MEDIA_STORE, MediaMarker } from "./directory-media.entity.js"
import type { DirectoryMediaOptions } from "./directory-media.entity.js"
import { abandoned, errorCodeOf, messageOf, temporaryName } from "./directory-media.entity.functions.js"

/** One file system call; its failure as it came. */
const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => cause })

/** Whether a failure says nothing is at the path. */
const isMissing = (cause: unknown) => Option.contains(errorCodeOf(cause), "ENOENT")

/** Whether a failure says the name is taken. */
const isTaken = (cause: unknown) => Option.contains(errorCodeOf(cause), "EEXIST")

/** A file system failure as the store's, in one place: the medium failed, with what was being done. */
const unavailable = (doing: string) => (cause: unknown) => new MediaUnavailable({ message: `${doing}: ${messageOf(cause)}`, cause })

/** The platform's SHA-256: the same key as the contract's pure `mediaHashOf`, at native speed. */
const sha256 = (bytes: Uint8Array): MediaHash => MediaHash.make(createHash("sha256").update(bytes).digest("hex"))

/** Write a new file whole, readable by its owner alone, and flush it. A name taken fails `EEXIST`. */
const writeSynced = (file: string, bytes: Uint8Array) => call(() => open(file, "wx", 0o600).then((handle) => handle.writeFile(bytes).then(() => handle.sync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/** Flush a folder's entries after a link or a rename, so they outlive a power loss; a file system that cannot is passed over. */
const syncFolder = (folder: string) => call(() => open(folder, "r").then((handle) => handle.sync().then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
))).pipe(Effect.catch((cause) => Effect.logDebug(`the folder ${folder} could not be flushed`, cause)))

/** Remove a temporary file, whatever became of it; one that cannot be removed is left for an opening's sweep. */
const removeTemporary = (file: string) => call(() => unlink(file)).pipe(
  Effect.catch((cause) => (isMissing(cause) ? Effect.void : Effect.logDebug(`a temporary media file was left for a later sweep: ${file}`, cause))),
)

/** A blob read whole, at most `bound` bytes and one more: what tells a file too long for the store. */
const readBounded = (file: string, bound: number) => call((): Promise<Uint8Array> => open(file, "r").then((handle) => {
  const buffer = new Uint8Array(bound + 1)
  const fill = (at: number): Promise<number> => at === buffer.length
    ? Promise.resolve(at)
    : handle.read(buffer, at, buffer.length - at, at).then(({ bytesRead }) => (bytesRead === 0 ? at : fill(at + bytesRead)))
  return fill(0).then(
    (length) => handle.close().then(() => buffer.slice(0, length)),
    (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
  )
}))

const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(MediaMarker))

/**
 * A media store in a folder of the disk (ADR 0034): `MediaStore` over `node:fs`, on Node 24 and Bun.
 *
 * - **The folder** holds `media.json` (`MediaMarker`: this store, its layout, `sha256`), `blobs/<hash>` (the bytes,
 *   readable by their owner alone), `tmp/` and `damaged/`. A folder with another store's marker, or with other files
 *   and no marker, is refused (`MediaUnavailable`) and left as it is. A missing folder is made.
 * - **A put is atomic**: the bytes are copied and hashed, then written to a temporary file in `tmp/`, flushed, and
 *   published under their key by an exclusive hard link, then the folder is flushed; the publication runs
 *   uninterruptibly. A crash leaves the blob whole or absent, and perhaps a temporary file, which a get never reads and
 *   an opening removes once it is an hour old. Bytes already kept are not written again. Two stores of two processes
 *   putting the same bytes converge: the second link finds the name taken and the blob there whole. No writer lock is
 *   taken: a blob never changes once kept, and its name is its content.
 * - **A get verifies**: it reads at most `maxBytes` and one more, and gives the bytes only when their SHA-256 is the key;
 *   anything else under the key (cut short, changed, too long) is `MediaDamaged`, never nothing. A put of the right
 *   bytes over a damaged blob keeps the damaged file in `damaged/` and renames the good bytes over it.
 *
 * Each call is one span, `directory_media.<call>`. A bound that is no whole number of 1 or more dies where the layer
 * is built.
 *
 * @public
 */
export const directoryMedia = (options: DirectoryMediaOptions): Layer.Layer<MediaStore, MediaUnavailable> => Layer.effect(MediaStore, Effect.gen(function* () {
  const maxBytes = options.maxBytes ?? MEDIA_LIMIT
  if (!isBound(maxBytes)) return yield* Effect.die(new Error(`directoryMedia: maxBytes must be a whole number of at least 1, not ${maxBytes}`))
  const root = options.directory
  const blobs = join(root, "blobs")
  const temporary = join(root, "tmp")
  const kept = join(root, "damaged")
  const marker = join(root, "media.json")
  const opening = unavailable(`the media folder ${root} cannot be opened`)

  /** The folder's marker: this store's (`true`), none (`false`), or a refusal. */
  const markerFound = call(() => readFile(marker, "utf8")).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) => (isMissing(cause) ? Effect.succeed(Option.none<string>()) : Effect.fail(opening(cause)))),
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (text) => Option.match(decodeMarker(text), {
        onNone: () => Effect.fail(new MediaUnavailable({ message: `the media folder ${root} holds a media.json that is no media store's marker` })),
        onSome: (found) => found.store === MEDIA_STORE && found.layout === MEDIA_LAYOUT && found.algorithm === "sha256"
          ? Effect.succeed(true)
          : Effect.fail(new MediaUnavailable({ message: `the media folder ${root} is a store of another kind or layout (${found.store}, layout ${found.layout}, ${found.algorithm})` })),
      }),
    })),
  )

  yield* call(() => mkdir(root, { recursive: true, mode: 0o700 })).pipe(Effect.mapError(opening))
  if (!(yield* markerFound)) {
    const names = yield* call(() => readdir(root)).pipe(Effect.mapError(opening))
    // A marker another opening of a fresh folder published meanwhile is no other file: its link is read below.
    const other = names.filter((name) => name !== "media.json" && !MEDIA_FOLDERS.includes(name))
    if (other.length > 0) {
      return yield* Effect.fail(new MediaUnavailable({ message: `the media folder ${root} holds other files (${other.slice(0, 3).join(", ")}) and no media.json: it is not made a store` }))
    }
    yield* call(() => mkdir(temporary, { recursive: true, mode: 0o700 })).pipe(Effect.mapError(opening))
    const draft = join(temporary, temporaryName("marker", yield* Clock.currentTimeMillis, randomUUID()))
    yield* Effect.gen(function* () {
      yield* writeSynced(draft, new TextEncoder().encode(`${JSON.stringify({ store: MEDIA_STORE, layout: MEDIA_LAYOUT, algorithm: "sha256" })}\n`)).pipe(Effect.mapError(opening))
      // Two openings at once: the second link finds the name taken, and reads the first's marker.
      yield* call(() => link(draft, marker)).pipe(Effect.catch((cause) => (isTaken(cause) ? Effect.asVoid(markerFound) : Effect.fail(opening(cause)))))
      yield* syncFolder(root)
    }).pipe(Effect.ensuring(removeTemporary(draft)), Effect.uninterruptible)
  }
  yield* Effect.forEach([blobs, temporary, kept], (folder) => call(() => mkdir(folder, { recursive: true, mode: 0o700 })), { concurrency: 1, discard: true }).pipe(Effect.mapError(opening))

  // Temporary files a stopped process left between its write and its link: removed once they are surely abandoned.
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const names = yield* call(() => readdir(temporary))
    yield* Effect.forEach(names.filter((name) => abandoned(name, now)), (name) => removeTemporary(join(temporary, name)), { concurrency: 1, discard: true })
  }).pipe(Effect.ignore({ log: "Debug", message: "the media folder's abandoned temporary files were not swept" }))

  /** What is kept under a key: its bytes, verified; nothing; or damage. */
  const blobAt = (hash: MediaHash): Effect.Effect<Option.Option<Uint8Array>, MediaUnavailable | MediaDamaged> => readBounded(join(blobs, hash), maxBytes).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) => (isMissing(cause) ? Effect.succeed(Option.none<Uint8Array>()) : Effect.fail(unavailable(`the media ${hash} could not be read`)(cause)))),
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Option.none<Uint8Array>()),
      onSome: (bytes) => {
        if (bytes.length > maxBytes) return Effect.fail(new MediaDamaged({ hash, message: `the file kept under ${hash} is longer than the ${maxBytes} bytes this store keeps under one key` }))
        if (bytes.length === 0 || sha256(bytes) !== hash) return Effect.fail(new MediaDamaged({ hash, message: `the file kept under ${hash} does not hold the bytes of that key` }))
        return Effect.succeed(Option.some(bytes))
      },
    })),
  )

  /** Whether a key's blob is whole, absent or damaged now. */
  const presence = (hash: MediaHash) => blobAt(hash).pipe(
    Effect.map((found) => (Option.isSome(found) ? "whole" as const : "absent" as const)),
    Effect.catchTag("MediaDamaged", () => Effect.succeed("damaged" as const)),
  )

  /** Keep the damaged file in `damaged/`, then rename the good bytes over it. */
  const repair = (hash: MediaHash, draft: string) => Effect.gen(function* () {
    const evidence = join(kept, `${hash}.${yield* Clock.currentTimeMillis}.${randomUUID()}`)
    yield* call(() => link(join(blobs, hash), evidence)).pipe(Effect.catch((cause) => (isMissing(cause) ? Effect.void : Effect.fail(unavailable(`the damaged media ${hash} could not be kept`)(cause)))))
    yield* call(() => rename(draft, join(blobs, hash))).pipe(Effect.mapError(unavailable(`the media ${hash} could not be repaired`)))
    yield* Effect.logWarning(`a damaged media blob was replaced by the bytes put again; the damaged file is in ${kept}`).pipe(Effect.annotateLogs({ "efferent.media.hash": hash }))
  })

  return MediaStore.of({
    maxBytes,
    put: Effect.fn("directory_media.put")(function* (bytes) {
      const copy = yield* Effect.fromResult(checkedBytes(bytes, maxBytes))
      const hash = sha256(copy)
      const now = yield* presence(hash)
      if (now === "whole") return hash
      const draft = join(temporary, temporaryName(hash, yield* Clock.currentTimeMillis, randomUUID()))
      yield* Effect.gen(function* () {
        yield* writeSynced(draft, copy).pipe(Effect.mapError(unavailable(`the media ${hash} could not be written`)))
        if (now === "damaged") yield* repair(hash, draft)
        else {
          yield* call(() => link(draft, join(blobs, hash))).pipe(Effect.catch((cause) => isTaken(cause)
            // Another put published it first, here or in another process: whole, or damaged and repaired now.
            ? Effect.flatMap(presence(hash), (found) => (found === "damaged" ? repair(hash, draft) : found === "whole" ? Effect.void : Effect.fail(unavailable(`the media ${hash} could not be published`)(cause))))
            : Effect.fail(unavailable(`the media ${hash} could not be published`)(cause))))
        }
        yield* syncFolder(blobs)
      }).pipe(Effect.ensuring(removeTemporary(draft)), Effect.uninterruptible)
      return hash
    }),
    get: Effect.fn("directory_media.get")(function* (hash) {
      return yield* blobAt(yield* Effect.fromResult(checkedKey(hash)))
    }),
  })
}))
