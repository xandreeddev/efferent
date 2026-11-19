import { Option } from "effect"
import { LOCKFILE_MANIFESTS } from "./file-verdict.entity.js"
import type { AttributeRule, FileStats, FileVerdict } from "./file-verdict.entity.js"

/** A path's last segment. */
export const nameOf = (path: string): string => path.split("/").at(-1) ?? path

/** Whether a path is a lockfile (`LOCKFILE_MANIFESTS`), by its name. */
export const isLockfile = (path: string): boolean => Object.hasOwn(LOCKFILE_MANIFESTS, nameOf(path))

/** A `.gitattributes` pattern as a regular expression over a path from the repository's root, as git matches it. */
const patternOf = (pattern: string): RegExp => {
  const anchored = pattern.includes("/")
  const body = pattern.replace(/^\//, "")
  let source = ""
  for (let at = 0; at < body.length; at++) {
    const char = body[at] ?? ""
    if (body.startsWith("**/", at)) {
      source += "(?:.*/)?"
      at += 2
    } else if (body.startsWith("/**", at) && at + 3 === body.length) {
      source += "/.*"
      at += 2
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`)
}

/**
 * The lines of a `.gitattributes` text that set or unset `linguist-generated` or `linguist-vendored`, in order.
 * Blank lines, comments, macros (`[attr]`) and lines that name neither are left out.
 */
export const attributesOf = (text: string): ReadonlyArray<AttributeRule> =>
  text.split("\n").flatMap((raw) => {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith("[attr]")) return []
    const [pattern = "", ...attributes] = line.split(/\s+/)
    const valueOf = (name: string): Option.Option<boolean> => {
      const set = attributes.findLast((attribute) => attribute === name || attribute === `-${name}` || attribute === `!${name}` || attribute.startsWith(`${name}=`))
      if (set === undefined) return Option.none()
      if (set === name) return Option.some(true)
      if (set.startsWith(`${name}=`)) return Option.some(!["false", "0"].includes(set.slice(name.length + 1)))
      return Option.some(false)
    }
    const generated = valueOf("linguist-generated")
    const vendored = valueOf("linguist-vendored")
    return Option.isNone(generated) && Option.isNone(vendored) ? [] : [{ pattern, generated, vendored }]
  })

/** What the last rule matching `path` says of an attribute, as git applies `.gitattributes`: the last match wins. */
const attributeOf = (path: string, rules: ReadonlyArray<AttributeRule>, pick: (rule: AttributeRule) => Option.Option<boolean>): Option.Option<boolean> =>
  rules.reduce<Option.Option<boolean>>((found, rule) => {
    const value = pick(rule)
    return Option.isSome(value) && patternOf(rule.pattern).test(path) ? value : found
  }, Option.none())

/**
 * Whether a changed file goes into the diff the model reads, and why not: a lockfile by its name; a file the base's
 * `.gitattributes` marks `linguist-generated` or `linguist-vendored` (a folder's name alone drops nothing); a binary
 * file; a deleted file. A file that stays but only loses lines is kept. The first that holds is the reason.
 */
export const fileVerdict = (path: string, stats: FileStats, attributes: ReadonlyArray<AttributeRule>): FileVerdict => {
  if (isLockfile(path)) return { _tag: "Dropped", path, reason: "lockfile" }
  if (Option.getOrElse(attributeOf(path, attributes, (rule) => rule.generated), () => false)) return { _tag: "Dropped", path, reason: "generated" }
  if (Option.getOrElse(attributeOf(path, attributes, (rule) => rule.vendored), () => false)) return { _tag: "Dropped", path, reason: "vendored" }
  if (stats.binary) return { _tag: "Dropped", path, reason: "binary" }
  if (stats.change === "deleted") return { _tag: "Dropped", path, reason: "deleted" }
  return { _tag: "Kept", path }
}
