import { Option, Schema } from "effect"

/**
 * The SPEC artifact of the spec-driven pipeline: a rough idea becomes a
 * SpecDoc (drafted by the refiner agent, refined WITH the human, LOCKED by
 * the human), and only a locked spec forges. Persisted as
 * `<workspace>/.efferent/specs/<slug>.md` — git-committable provenance (the
 * persisted `FactoryRun.spec` ties back to it). See `docs/agents/coder.md`.
 *
 * The wire format is markdown: flat YAML-ish frontmatter (the machine half —
 * the shared `parseFrontmatter` is flat `key: value` only) + strict sections
 * (the human half): `# Goal`, `## Acceptance`, `## Checks` (`- name: command`
 * bullets — machine-checkable acceptance, which drivers turn into rank-2
 * command gates), `## Constraints`, `## Non-goals`. The codec lives in
 * `usecases/specCodec.ts` and round-trips deterministically.
 */

/** Kebab-case spec identity — the file's basename, minted once. */
export const SpecSlug = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]*$/),
  Schema.brand("SpecSlug"),
)
export type SpecSlug = typeof SpecSlug.Type

export const SpecStatus = Schema.Literal("draft", "locked")
export type SpecStatus = typeof SpecStatus.Type

/** A machine-checkable acceptance criterion: a named shell command that must
 *  exit 0. Drivers append one rank-2 command gate per check (`accept:<name>`). */
export class SpecCheck extends Schema.Class<SpecCheck>("SpecCheck")({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/)),
  command: Schema.NonEmptyString,
}) {}

/** Forge-loop bounds (mirrors foundry's ForgeLimits, in human units). */
export class SpecLimits extends Schema.Class<SpecLimits>("SpecLimits")({
  maxAttempts: Schema.Int.pipe(Schema.between(1, 10)),
  budgetMinutes: Schema.Positive,
}) {}

/** Gate-suite selection overrides; absent fields fall through to the driver's
 *  workspace discovery (precedence: CLI flags > these > discovery). */
export class SpecGates extends Schema.Class<SpecGates>("SpecGates")({
  config: Schema.optionalWith(Schema.NonEmptyString, { as: "Option" }),
  testCommand: Schema.optionalWith(Schema.NonEmptyString, { as: "Option" }),
  noTest: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** The rank-4 LLM judge — ON by default; a spec opts out with `judge: false`. */
  judge: Schema.optionalWith(Schema.Boolean, { default: () => true }),
}) {}

export class SpecDoc extends Schema.Class<SpecDoc>("SpecDoc")({
  slug: SpecSlug,
  status: SpecStatus,
  /** ISO timestamps — strings on purpose (stable round-trip, no Date drift). */
  created: Schema.NonEmptyString,
  locked: Schema.optionalWith(Schema.NonEmptyString, { as: "Option" }),
  /** One imperative paragraph — becomes foundry `Spec.goal`. */
  goal: Schema.NonEmptyString,
  /** Rendered verbatim into the implementor brief; also foundry `Spec.acceptance`. */
  acceptance: Schema.Array(Schema.NonEmptyString),
  /** Hard boundaries for the implementor (brief-only; never enter foundry's Spec). */
  constraints: Schema.Array(Schema.NonEmptyString),
  /** Explicit scope fences (brief-only). */
  nonGoals: Schema.Array(Schema.NonEmptyString),
  checks: Schema.Array(SpecCheck),
  limits: SpecLimits,
  gates: SpecGates,
}) {}

export const DEFAULT_SPEC_LIMITS = new SpecLimits({ maxAttempts: 3, budgetMinutes: 15 })

/**
 * The prompt section a spec-carrying session renders each turn — the
 * deterministic successor of the old Directive section: the agent works TO
 * the acceptance criteria, and deterministic gates (not an LLM judge) decide
 * whether the work is done.
 */
export const renderSpecSection = (doc: SpecDoc): string => {
  const bullets = (items: ReadonlyArray<string>): string =>
    items.map((item) => `- ${item}`).join("\n")
  const acceptance =
    doc.acceptance.length === 0 ? "" : `\n\n## Acceptance\n${bullets(doc.acceptance)}`
  const checks =
    doc.checks.length === 0
      ? ""
      : `\n\n## Machine checks (deterministic gates — these MUST pass)\n${doc.checks
          .map((check) => `- ${check.name}: \`${check.command}\``)
          .join("\n")}`
  const constraints =
    doc.constraints.length === 0 ? "" : `\n\n## Constraints\n${bullets(doc.constraints)}`
  const nonGoals =
    doc.nonGoals.length === 0 ? "" : `\n\n## Non-goals\n${bullets(doc.nonGoals)}`
  return `# Spec (${doc.status}): ${doc.slug}

${doc.goal}${acceptance}${checks}${constraints}${nonGoals}

Work to this spec. The acceptance criteria are the contract; deterministic gates judge the workspace — the spec is done when the gates say so, not when the work feels finished.`
}
