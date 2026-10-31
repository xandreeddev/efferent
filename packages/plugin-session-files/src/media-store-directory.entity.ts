import { Schema } from "effect"

/** Independent of the session log's store.json and FILES_LAYOUT. */
export const MEDIA_DIRECTORY_LAYOUT = 1
export const MediaDirectoryMarker = Schema.Struct({ layout: Schema.Int, algorithm: Schema.Literal("sha256") })
