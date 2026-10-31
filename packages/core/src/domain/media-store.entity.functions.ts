import { sha256BytesOf } from "../turn/request-part.entity.functions.js"
import { MediaHash } from "./media-store.entity.js"

/** SHA-256 of the bytes themselves, with no image validation or byte-store size restriction. @public */
export const mediaHashOf = (bytes: Uint8Array): MediaHash => MediaHash.make(sha256BytesOf(bytes))
