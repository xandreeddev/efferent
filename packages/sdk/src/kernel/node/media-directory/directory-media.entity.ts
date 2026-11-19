import { Schema } from "effect"

/**
 * What `directoryMedia` is given: `directory`, the folder of the store (made when missing), and `maxBytes`, the most
 * bytes it keeps under one key (`MEDIA_LIMIT` by default). A store's bound is not lowered under bytes it holds: a
 * blob longer than the bound it is opened with reads as damaged.
 *
 * @public
 */
export interface DirectoryMediaOptions {
  readonly directory: string
  readonly maxBytes?: number
}

/** What `media.json` names a folder's store: this one's. */
export const MEDIA_STORE = "efferent-media"

/** The layout of the folder: `blobs/<hash>`, `tmp/`, `damaged/`. Another one is refused, left as it is. */
export const MEDIA_LAYOUT = 1

/** `media.json`: which store a folder is, in which layout, keyed by which hash. */
export const MediaMarker = Schema.Struct({
  store: Schema.String,
  layout: Schema.Int,
  algorithm: Schema.String,
})
export type MediaMarker = typeof MediaMarker.Type

/** The folders of a store: what a folder with no marker may already hold and still be made one. */
export const MEDIA_FOLDERS: ReadonlyArray<string> = ["blobs", "tmp", "damaged"]

/**
 * How old a temporary file must be before an opening sweeps it: a put publishes its file within a few calls, so one
 * this old was left by a process that stopped (an hour also covers clocks that disagree on a shared mount).
 */
export const TEMPORARY_GRACE_MS = 60 * 60 * 1000
