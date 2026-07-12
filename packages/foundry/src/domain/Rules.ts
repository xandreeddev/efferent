import { Schema } from "effect"
import { RuleId } from "./Brands.js"
import { Severity } from "./Finding.js"

/**
 * Rules-as-data: WHICH rules run WHERE is config, not code. A config file
 * exports a plain object (`typeof GateSuiteConfig.Encoded`); the CLI decodes
 * it — authors never touch `Option`, consumers never touch `undefined`.
 */

export class RuleConfig extends Schema.Class<RuleConfig>("RuleConfig")({
  rule: RuleId,
  /** Overrides the rule's default severity. */
  severity: Schema.optionalWith(Severity, { as: "Option" }),
  /** Globs relative to the workspace root. */
  include: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), {
    default: () => ["**/*.ts"],
  }),
  exclude: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
}) {}

export class LayerSpec extends Schema.Class<LayerSpec>("LayerSpec")({
  name: Schema.NonEmptyString,
  /** Glob (workspace-relative) locating this layer's files. */
  path: Schema.NonEmptyString,
  /** Names of layers this one may import (itself is always allowed). */
  canImport: Schema.Array(Schema.NonEmptyString),
  /** Allowed external module prefixes (e.g. `effect`, `typescript`, `node:`). */
  externals: Schema.Array(Schema.NonEmptyString),
}) {}

export class LayerConfig extends Schema.Class<LayerConfig>("LayerConfig")({
  layers: Schema.NonEmptyArray(LayerSpec),
}) {}

export class EvalShapeConfig extends Schema.Class<EvalShapeConfig>("EvalShapeConfig")({
  /** Workspace-relative path of the suite registry module. */
  registry: Schema.NonEmptyString,
  suiteGlob: Schema.optionalWith(Schema.NonEmptyString, { default: () => "**/*.eval.ts" }),
}) {}

/** A STANDING command check — the project's own scripts (lint, format,
 *  design-token audits) as part of the profile: exit 0 = clean. Armed by
 *  smith's gate discovery as rank-2 command gates; the `foundry check` CLI
 *  ignores them (it runs the static suite only). */
export class CheckConfig extends Schema.Class<CheckConfig>("CheckConfig")({
  name: Schema.NonEmptyString,
  /** One line of shell, run through `bash -c` from the workspace root. */
  command: Schema.NonEmptyString,
  /** Cost rank for a standing command. Existing profiles decode as `test`. */
  kind: Schema.optionalWith(Schema.Literal("test", "eval"), { default: () => "test" }),
  /** Per-command wall-clock bound. */
  timeoutMs: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 300_000,
  }),
}) {}

/** One gate-suite target: a tsconfig + the rule/boundary/eval policy over it. */
export class GateSuiteConfig extends Schema.Class<GateSuiteConfig>("GateSuiteConfig")({
  /** Workspace-relative path to the tsconfig the shared `ts.Program` builds from. */
  tsconfig: Schema.NonEmptyString,
  rules: Schema.Array(RuleConfig),
  boundaries: Schema.optionalWith(LayerConfig, { as: "Option" }),
  evalShape: Schema.optionalWith(EvalShapeConfig, { as: "Option" }),
  checks: Schema.optionalWith(Schema.Array(CheckConfig), { default: () => [] }),
  /** Run the typecheck gate too. Set false when `tsc` already runs beside
   *  this check (e.g. the repo's `bun run typecheck`) — no double program check. */
  typecheck: Schema.optionalWith(Schema.Boolean, { default: () => true }),
}) {}
