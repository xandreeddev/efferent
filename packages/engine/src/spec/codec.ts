import { Array as Arr, Data, Effect, Option, Schema } from "effect"
import { SpecDoc } from "./SpecDoc.js"
import type { SpecSlug } from "./SpecDoc.js"
import { SpecSlug as SpecSlugSchema } from "./SpecDoc.js"
import { parseFrontmatter } from "./frontmatter.js"

/** A SpecDoc file that doesn't decode — names the exact violation. */
export class SpecDocParseError extends Data.TaggedError("SpecDocParseError")<{
  readonly message: string
}> {}

const SECTION_HEADERS = ["Acceptance", "Checks", "Constraints", "Non-goals"] as const
type SectionHeader = (typeof SECTION_HEADERS)[number]

interface ParsedSections {
  readonly goal: string
  readonly bullets: Readonly<Record<SectionHeader, ReadonlyArray<string>>>
}

const emptyBullets: Record<SectionHeader, ReadonlyArray<string>> = {
  Acceptance: [],
  Checks: [],
  Constraints: [],
  "Non-goals": [],
}

/**
 * The strict section grammar: `# Goal` (paragraph) then any of
 * `## Acceptance` / `## Checks` / `## Constraints` / `## Non-goals`, each a
 * list of `- ` bullets. Unknown `##` headers are ERRORS (strictness is what
 * makes the codec a deterministic fold with a round-trip law); blank lines
 * are insignificant.
 */
const parseSections = (body: string): Effect.Effect<ParsedSections, SpecDocParseError> => {
  const lines = body.split("\n")
  const folded = lines.reduce(
    (
      acc: {
        readonly current: "goal" | SectionHeader | "none"
        readonly goalLines: ReadonlyArray<string>
        readonly bullets: Record<SectionHeader, ReadonlyArray<string>>
        readonly error: Option.Option<string>
      },
      rawLine,
    ) => {
      if (Option.isSome(acc.error)) return acc
      const line = rawLine.trimEnd()
      if (line.startsWith("# ")) {
        return line === "# Goal"
          ? { ...acc, current: "goal" as const }
          : { ...acc, error: Option.some(`unknown top-level section "${line}" (only "# Goal")`) }
      }
      if (line.startsWith("## ")) {
        const header = line.slice(3).trim()
        const known = SECTION_HEADERS.find((h) => h === header)
        return known === undefined
          ? {
              ...acc,
              error: Option.some(
                `unknown section "## ${header}" (allowed: ${SECTION_HEADERS.join(", ")})`,
              ),
            }
          : { ...acc, current: known }
      }
      if (acc.current === "goal") {
        return { ...acc, goalLines: [...acc.goalLines, line] }
      }
      if (acc.current !== "none" && line.trim().startsWith("- ")) {
        const bullet = line.trim().slice(2).trim()
        return bullet.length === 0
          ? acc
          : {
              ...acc,
              bullets: {
                ...acc.bullets,
                [acc.current]: [...acc.bullets[acc.current], bullet],
              },
            }
      }
      if (acc.current !== "none" && line.trim().length > 0) {
        return {
          ...acc,
          error: Option.some(
            `section "## ${acc.current}" only takes "- " bullets (got: "${line.trim()}")`,
          ),
        }
      }
      return acc
    },
    { current: "none" as const, goalLines: [], bullets: emptyBullets, error: Option.none<string>() },
  )
  if (Option.isSome(folded.error)) {
    return Effect.fail(new SpecDocParseError({ message: folded.error.value }))
  }
  const goal = folded.goalLines.join("\n").trim()
  if (goal.length === 0) {
    return Effect.fail(new SpecDocParseError({ message: 'missing "# Goal" section' }))
  }
  return Effect.succeed({ goal, bullets: folded.bullets })
}

/** `- name: command` check bullets → structured pairs. */
const parseCheckBullet = (bullet: string): Effect.Effect<{ name: string; command: string }, SpecDocParseError> => {
  const colon = bullet.indexOf(":")
  if (colon === -1) {
    return Effect.fail(
      new SpecDocParseError({ message: `check bullet needs "name: command" (got "${bullet}")` }),
    )
  }
  return Effect.succeed({
    name: bullet.slice(0, colon).trim(),
    command: bullet.slice(colon + 1).trim(),
  })
}

/**
 * Decode a SpecDoc file's text. The slug comes from the FILE NAME (the file
 * owns identity — it is not repeated in the frontmatter). Round-trip law:
 * `decodeSpecDocText(slug, encodeSpecDocText(doc)) ≡ doc`.
 */
export const decodeSpecDocText = (
  slug: string,
  text: string,
): Effect.Effect<SpecDoc, SpecDocParseError> =>
  Effect.gen(function* () {
    const fm = yield* Option.match(parseFrontmatter(text), {
      onNone: () =>
        Effect.fail(
          new SpecDocParseError({ message: "missing/unterminated frontmatter fence" }),
        ),
      onSome: Effect.succeed,
    })
    const sections = yield* parseSections(fm.body)
    const checks = yield* Effect.forEach(sections.bullets.Checks, parseCheckBullet)
    const fields = fm.fields
    const numeric = (key: string, fallback: number): number => {
      const raw = fields[key]
      return raw === undefined || raw.length === 0 ? fallback : Number(raw)
    }
    const candidate = {
      slug,
      status: fields["status"] ?? "draft",
      created: fields["created"] ?? "",
      ...(fields["locked"] !== undefined && fields["locked"].length > 0
        ? { locked: fields["locked"] }
        : {}),
      goal: sections.goal,
      acceptance: sections.bullets.Acceptance,
      constraints: sections.bullets.Constraints,
      nonGoals: sections.bullets["Non-goals"],
      checks,
      limits: {
        maxAttempts: numeric("maxAttempts", 3),
        budgetMinutes: numeric("budgetMinutes", 15),
      },
      gates: {
        ...(fields["gatesConfig"] !== undefined && fields["gatesConfig"].length > 0
          ? { config: fields["gatesConfig"] }
          : {}),
        ...(fields["testCommand"] !== undefined && fields["testCommand"].length > 0
          ? { testCommand: fields["testCommand"] }
          : {}),
        ...(fields["noTest"] !== undefined ? { noTest: fields["noTest"] === "true" } : {}),
      },
    }
    return yield* Schema.decodeUnknown(SpecDoc)(candidate).pipe(
      Effect.mapError((error) => new SpecDocParseError({ message: String(error) })),
    )
  })

/** Prose bullets are single-line BY GRAMMAR — collapse any whitespace runs
 *  (incl. newlines) a model slipped in. Safe for prose; NEVER applied to
 *  check commands (semantics — the propose handler rejects those instead). */
export const normalizeBullet = (text: string): string => text.replace(/\s+/g, " ").trim()

/** Deterministic inverse of {@link decodeSpecDocText}: stable key order,
 *  canonical section order, absent options omitted. Prose bullets are
 *  normalized to keep the encode inside its own grammar (round-trip law). */
export const encodeSpecDocText = (doc: SpecDoc): string => {
  const frontmatter = [
    "---",
    "version: 1",
    `status: ${doc.status}`,
    `created: ${doc.created}`,
    ...Option.match(doc.locked, { onNone: () => [], onSome: (at) => [`locked: ${at}`] }),
    `maxAttempts: ${doc.limits.maxAttempts}`,
    `budgetMinutes: ${doc.limits.budgetMinutes}`,
    ...Option.match(doc.gates.config, { onNone: () => [], onSome: (c) => [`gatesConfig: ${c}`] }),
    ...Option.match(doc.gates.testCommand, {
      onNone: () => [],
      onSome: (c) => [`testCommand: ${c}`],
    }),
    ...(doc.gates.noTest ? ["noTest: true"] : []),
    "---",
  ].join("\n")
  const section = (header: SectionHeader, items: ReadonlyArray<string>): string =>
    items.length === 0 ? "" : `\n\n## ${header}\n${items.map((item) => `- ${item}`).join("\n")}`
  return `${frontmatter}

# Goal
${doc.goal}${section("Acceptance", doc.acceptance.map(normalizeBullet))}${section(
    "Checks",
    doc.checks.map((check) => `${check.name}: ${check.command}`),
  )}${section("Constraints", doc.constraints.map(normalizeBullet))}${section(
    "Non-goals",
    doc.nonGoals.map(normalizeBullet),
  )}
`
}

/** Deterministic kebab slug from a goal/idea (mint once; the file owns it). */
export const specSlug = (goal: string): SpecSlug => {
  const kebab = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return SpecSlugSchema.make(kebab.length === 0 ? "spec" : kebab)
}

/** First-wins collision suffixing over an existing-name predicate. */
export const uniqueSlug = (base: SpecSlug, taken: (slug: string) => boolean): SpecSlug =>
  taken(base)
    ? SpecSlugSchema.make(
        Option.getOrElse(
          Arr.findFirst(
            Arr.range(2, 99),
            (n) => !taken(`${base}-${n}`),
          ).pipe(Option.map((n) => `${base}-${n}`)),
          () => `${base}-${Date.now()}`,
        ),
      )
    : base
