import { Option, Predicate } from "effect"
import { TEMPORARY_GRACE_MS } from "./directory-media.entity.js"

/**
 * The name of a temporary file: what it is for (a blob's hash, or `marker`), when it was made and a unique id, so an
 * opening can tell one a stopped process left from one a put is writing.
 */
export const temporaryName = (purpose: string, at: number, id: string): string => `${purpose}.${at}.${id}.tmp`

/** When a temporary file this store writes was made, from its name; none for a name it does not write. */
export const madeAt = (name: string): Option.Option<number> => Option.map(
  Option.fromNullishOr(/^(?:[0-9a-f]{64}|marker)\.(\d{1,16})\.[0-9a-f-]{36}\.tmp$/.exec(name)?.[1]), Number)

/** Whether a temporary file is surely abandoned at `now`: one this store wrote, made more than the grace ago. */
export const abandoned = (name: string, now: number): boolean => Option.exists(madeAt(name), (at) => now - at > TEMPORARY_GRACE_MS)

/** The code Node or Bun gives a file system failure, when it gives one. */
export const errorCodeOf = (error: unknown): Option.Option<string> =>
  Predicate.isObject(error) ? Option.filter(Option.some(error["code"]), Predicate.isString) : Option.none()

/** A failure's own words, for a message about it. */
export const messageOf = (error: unknown): string =>
  Predicate.isObject(error) && Predicate.isString(error["message"]) ? error["message"] : "the file system failed"
