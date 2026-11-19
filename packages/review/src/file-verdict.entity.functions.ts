import { Option } from "effect"
import type { AttributeRule, FileStats, FileVerdict } from "./file-verdict.entity.js"

/** Lockfiles, by name: what a package manager writes, never what a person reviews. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "deno.lock",
  "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock", "Gemfile.lock", "composer.lock",
  "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json", "flake.lock", "gradle.lockfile",
])

/** Folders whose files are someone else's code, at any depth. */
export const VENDORED_FOLDERS: ReadonlySet<string> = new Set(["vendor", "vendored", "third_party", "third-party", "node_modules", "bower_components"])

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
 * Whether a changed file goes into the diff the model reads, and why not: a lockfile by its name; a file
 * `.gitattributes` marks `linguist-generated`; one it marks `linguist-vendored`, or in a vendored folder it does not
 * unmark; a binary file; a file that adds no line and removes some. The first that holds is the reason.
 */
export const fileVerdict = (path: string, stats: FileStats, attributes: ReadonlyArray<AttributeRule>): FileVerdict => {
  const name = path.split("/").at(-1) ?? path
  const folders = path.split("/").slice(0, -1)
  const generated = attributeOf(path, attributes, (rule) => rule.generated)
  const vendored = attributeOf(path, attributes, (rule) => rule.vendored)
  if (LOCKFILES.has(name)) return { _tag: "Dropped", path, reason: "lockfile" }
  if (Option.getOrElse(generated, () => false)) return { _tag: "Dropped", path, reason: "generated" }
  if (Option.getOrElse(vendored, () => folders.some((folder) => VENDORED_FOLDERS.has(folder)))) return { _tag: "Dropped", path, reason: "vendored" }
  if (stats.binary) return { _tag: "Dropped", path, reason: "binary" }
  if (stats.additions === 0 && stats.deletions > 0) return { _tag: "Dropped", path, reason: "deletion-only" }
  return { _tag: "Kept", path }
}
