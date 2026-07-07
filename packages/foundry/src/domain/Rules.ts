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

/** One gate-suite target: a tsconfig + the rule/boundary/eval policy over it. */
export class GateSuiteConfig extends Schema.Class<GateSuiteConfig>("GateSuiteConfig")({
  /** Workspace-relative path to the tsconfig the shared `ts.Program` builds from. */
  tsconfig: Schema.NonEmptyString,
  rules: Schema.Array(RuleConfig),
  boundaries: Schema.optionalWith(LayerConfig, { as: "Option" }),
  evalShape: Schema.optionalWith(EvalShapeConfig, { as: "Option" }),
}) {}
