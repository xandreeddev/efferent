export interface Frontmatter {
  /** Flat `key: value` pairs from the fence. No arrays / nested YAML. */
  readonly fields: Record<string, string>
  /** Everything after the closing fence, leading blank lines trimmed. */
  readonly body: string
}

/**
 * The one frontmatter parser shared by scopes, skills, and agent definitions:
 * a `---\n…\n---` fence at the top with `key: value` lines inside, then a
 * free-form body. Values are taken verbatim, trimmed, surrounding quotes
 * stripped; comment (`#`) and blank lines are skipped. No arrays, no nested
 * YAML, no multi-line values. Returns `undefined` when the fence is missing or
 * unterminated. Callers decide which `fields` are required.
 */
export const parseFrontmatter = (content: string): Frontmatter | undefined => {
  if (!content.startsWith("---")) return undefined
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return undefined
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return undefined
  const frontmatter = afterFirstFence.slice(0, closeIndex)
  const body = afterFirstFence.slice(closeIndex + 4).replace(/^\n+/, "")

  const fields: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
    fields[key] = value
  }
  return { fields, body }
}
