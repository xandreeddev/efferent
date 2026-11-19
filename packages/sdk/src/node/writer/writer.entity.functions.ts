import { Match, Option, Predicate } from "effect"
import type { Found, Holder, ThisProcess, Verdict } from "./writer.entity.js"

/** The number a holder file's name carries (`<n>.json`); none for any other name (a file being written, a stray one). */
export const holderNumberOf = (name: string): Option.Option<number> => {
  const match = /^([1-9]\d{0,14})\.json$/.exec(name)
  return match === null ? Option.none() : Option.some(Number(match[1]))
}

/** A holder as a refusal names it. */
export const holderText = (holder: Holder): string =>
  `process ${holder.pid} on ${holder.host}, since ${new Date(holder.since).toISOString()}`

/**
 * What to do about the holder file found with the highest number. None: take
 * the first number. A holder on this machine whose process is gone (`alive` is
 * false), or one that names this process's id, which a process before this one
 * had (this process asks only when it holds no lock on the store): take the next
 * number. A live holder, one on another machine (whose processes this one
 * cannot see) and a file that does not decode: leave the store to it, and say
 * which file to remove if its process is gone.
 */
export const verdictOf = (found: Found, me: ThisProcess, alive: boolean, file: (number: number) => string): Verdict => Match.valueTags(found, {
  None: (): Verdict => ({ _tag: "Take", number: 1 }),
  Unreadable: ({ number }): Verdict => ({ _tag: "Held", why: `the lock file ${file(number)} does not name a holder; if no process holds the store, remove it` }),
  Holding: ({ holder, number }): Verdict => holder.host !== me.host
    ? { _tag: "Held", why: `held by ${holderText(holder)}, another machine, whose processes this one cannot see; if that process is gone, remove ${file(number)}` }
    : holder.pid === me.pid || !alive
      ? { _tag: "Take", number: number + 1 }
      : { _tag: "Held", why: `held by ${holderText(holder)}, which is running; if it is not the store's writer, stop it, or remove ${file(number)} once it is gone` },
})

/** The string `code` a foreign error carries (a Node error's `ENOENT`, Bun SQLite's `SQLITE_BUSY`), when it has one. */
export const errorCodeOf = (error: unknown): Option.Option<string> =>
  Predicate.isObject(error) ? Option.filter(Option.some(error["code"]), Predicate.isString) : Option.none()

/** A foreign error's message, for a refusal's words: its own when it is an `Error`, else none. */
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : "no reason given"
