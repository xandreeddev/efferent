/**
 * The checks between the published codes (`HARNESS_CODES`), the event
 * reference's entries for them and the codes the packages' source raises.
 * `generate-event-reference.ts` runs them and fails on any problem.
 */

/** The conformance kits' own codes: a kit's probe raises them in a host's place, so they are not the framework's. */
export const KIT_NAMESPACE = "conformance."

/**
 * The codes a package's source raises, read from its text: `code: "a.b"`,
 * or a call of the packages' error helpers, `failure("a.b"`, `harness("a.b"`,
 * `harnessError("a.b"` and `storage("a.b"`.
 */
export const raisedCodes = (sourceText: string): ReadonlySet<string> =>
  new Set(Array.from(sourceText.matchAll(/(?:\bcode:\s*|\b(?:failure|harness|harnessError|storage)\(\s*)"([a-z]+\.[a-z][a-z-]*)"/g), (match) => match[1] ?? ""))

export interface CodeList {
  /** The published codes, `HARNESS_CODES`. */
  readonly published: ReadonlyArray<string>
  /** The codes the reference's error and task tables explain, one entry each. */
  readonly entries: ReadonlyArray<string>
  /** The begin codes, which the reference's begin table explains. */
  readonly begin: ReadonlyArray<string>
  /** The codes the packages' source raises (`raisedCodes`). */
  readonly raised: ReadonlySet<string>
}

/**
 * What does not match: an entry twice, or for a code that is not published;
 * a published code without an entry; a begin code or a raised one, in any
 * namespace but the kits', that is not published. Empty when all agree.
 */
export const codeListProblems = ({ published, entries, begin, raised }: CodeList): ReadonlyArray<string> => {
  const isPublished = new Set(published)
  const explained = new Set([...entries, ...begin])
  return [
    ...entries.filter((code, index) => entries.indexOf(code) !== index).map((code) => `Error code ${code} has two entries`),
    ...entries.filter((code) => !isPublished.has(code)).map((code) => `Error code ${code} has an entry but is not in HARNESS_CODES`),
    ...begin.filter((code) => !isPublished.has(code)).map((code) => `Begin code ${code} is not in HARNESS_CODES`),
    ...published.filter((code) => !explained.has(code)).map((code) => `Published code ${code} has no entry in ERROR_CODES or TASK_CODES`),
    ...[...raised].filter((code) => !code.startsWith(KIT_NAMESPACE) && !isPublished.has(code)).toSorted()
      .map((code) => `Error code ${code} is raised in a package but not in HARNESS_CODES (packages/core/src/harness/harness-code.entity.ts)`),
  ]
}
