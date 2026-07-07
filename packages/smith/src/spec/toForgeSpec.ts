import { Effect, Option, Schema } from "effect"
import { ConfigError, Spec } from "@xandreed/foundry"
import { SpecDoc } from "@xandreed/sdk-core"
import type { SpecCheck, SpecSlug } from "@xandreed/sdk-core"
import type { SmithRunConfig } from "../domain/SmithConfig.js"

/**
 * The ONLY smith seam that maps the SpecDoc onto foundry's `Spec`
 * (goal/acceptance/limits — constraints and non-goals render into the
 * implementor brief, never into foundry). Bounds violations surface as
 * `ConfigError` (same discipline as the flag path).
 */
export const toForgeSpec = (doc: SpecDoc): Effect.Effect<Spec, ConfigError> =>
  Schema.decodeUnknown(Spec)({
    goal: doc.goal,
    acceptance: doc.acceptance,
    limits: {
      maxAttempts: doc.limits.maxAttempts,
      budgetMillis: doc.limits.budgetMinutes * 60_000,
    },
  }).pipe(
    Effect.mapError(
      (error) => new ConfigError({ path: `${doc.slug}.md`, message: String(error) }),
    ),
  )

/** What gate discovery actually consumes — flags > spec frontmatter > discovery. */
export interface GateSuiteRequest {
  readonly cwd: string
  readonly configPath: Option.Option<string>
  readonly testCommand: Option.Option<string>
  readonly noTest: boolean
  /** Machine-checkable acceptance from the spec → `accept-<name>` command gates. */
  readonly checks: ReadonlyArray<SpecCheck>
}

/**
 * The `smith "<task>"` shorthand: a trivial LOCKED SpecDoc from the flags —
 * written to `.efferent/specs/` for provenance even when nobody refined it.
 * Decoded (never constructed) so bad flag values are `ConfigError`s.
 */
export const trivialSpecDoc = (
  run: SmithRunConfig,
  slug: SpecSlug,
  now: string,
): Effect.Effect<SpecDoc, ConfigError> =>
  Schema.decodeUnknown(SpecDoc)({
    slug: String(slug),
    status: "locked",
    created: now,
    locked: now,
    goal: run.task,
    acceptance: run.acceptance,
    constraints: [],
    nonGoals: [],
    checks: [],
    limits: {
      maxAttempts: run.maxAttempts,
      budgetMinutes: Math.max(1, Math.round(run.budgetMillis / 60_000)),
    },
    gates: {},
  }).pipe(
    Effect.mapError(
      (error) => new ConfigError({ path: "<flags>", message: String(error) }),
    ),
  )

export const gateRequestFromSpec = (
  run: SmithRunConfig,
  doc: Option.Option<SpecDoc>,
): GateSuiteRequest => {
  const gates = Option.map(doc, (d) => d.gates)
  return {
    cwd: run.cwd,
    configPath: Option.orElse(run.configPath, () => Option.flatMap(gates, (g) => g.config)),
    testCommand: Option.orElse(run.testCommand, () =>
      Option.flatMap(gates, (g) => g.testCommand),
    ),
    noTest: run.noTest || Option.match(gates, { onNone: () => false, onSome: (g) => g.noTest }),
    checks: Option.match(doc, { onNone: () => [], onSome: (d) => d.checks }),
  }
}
