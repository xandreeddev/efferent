import { Option, Predicate } from "effect"

/** The name a write's temporary file takes in the folder of the file it replaces. */
export const tempNameOf = (id: string): string => `.efferent-${id}.tmp`

/** Whether a name is a write's temporary file: never listed, whether a write is under way or a crash left it. */
export const isTempName = (name: string): boolean => /^\.efferent-[0-9a-f-]{36}\.tmp$/.test(name)

/** Whether `real`, a real path, is in the folder `root` (a real path too), and not the folder itself. */
export const isInside = (root: string, real: string, separator: string): boolean =>
  real.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)

/** The string `code` a foreign error carries (a Node error's `ENOENT`), when it has one. */
export const errorCodeOf = (error: unknown): Option.Option<string> =>
  Predicate.isObject(error) ? Option.filter(Option.some(error["code"]), Predicate.isString) : Option.none()

/** A foreign failure's words: its own message when it is an `Error`. */
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : "no reason given"
