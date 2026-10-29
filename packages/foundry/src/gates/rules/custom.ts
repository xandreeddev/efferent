import { Effect, Option, Result, Schema } from "effect"
import { RuleId } from "../../domain/Brands.js"
import { ConfigError } from "../../domain/Errors.js"
import { Severity } from "../../domain/Finding.js"
import type { IdiomRule, RuleContext, RuleMatch } from "../idiomGate.js"

/**
 * The plug-in seam: a config module provides its OWN rules via named exports
 * (`rulePacks` / `customRules`). External workspaces cannot import foundry
 * (private, source-run), so plugged rules are PLAIN structural objects —
 * string ids, string severities, one check function — and the branding
 * (`RuleId.make`) happens HERE, in our decoder, never in the workspace.
 */

/** The data half of a plugged rule — Schema-decoded first, so a bad `check`
 *  is reported under the rule's id. */
const PluggedRuleMeta = Schema.Struct({
  id: RuleId,
  defaultSeverity: Severity,
  description: Schema.NonEmptyString,
  fixHint: Schema.NonEmptyString,
})

/** Any function: `failClosed` checks what it returns, on every call. */
const isCheck = (value: unknown): value is (ctx: RuleContext) => unknown => typeof value === "function"

const decodeCheck = Schema.decodeUnknownOption(Schema.Struct({ check: Schema.declare(isCheck) }))

/** A plugged pack's shape; its `rules` are decoded one entry at a time. */
const decodePackShape = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String, rules: Schema.Unknown }))

/** Wrap a plugged check FAIL-CLOSED: a crashing rule (or one returning a
 *  non-array) reports ITSELF as a finding on the file it was checking —
 *  never a defect, never a silent pass. */
const failClosed = (
  id: string,
  check: (ctx: RuleContext) => unknown,
): ((ctx: RuleContext) => ReadonlyArray<RuleMatch>) =>
  (ctx) =>
    Result.match(
      Result.try(() => check(ctx)),
      {
        onFailure: (error) => [
          { node: ctx.sourceFile, message: `rule ${id} crashed: ${String(error)}` },
        ],
        onSuccess: (result) =>
          Array.isArray(result)
            ? (result as ReadonlyArray<RuleMatch>)
            : [
                {
                  node: ctx.sourceFile,
                  message: `rule ${id} returned ${typeof result} — expected an array of matches`,
                },
              ],
      },
    )

const decodeOne = (
  configPath: string,
  label: string,
  entry: unknown,
): Effect.Effect<IdiomRule, ConfigError> =>
  Effect.gen(function* () {
    const meta = yield* Schema.decodeUnknownEffect(PluggedRuleMeta)(entry).pipe(
      Effect.mapError(
        (parseError) =>
          new ConfigError({ path: configPath, message: `${label}: ${parseError.message}` }),
      ),
    )
    return yield* Option.match(decodeCheck(entry), {
      onNone: () =>
        Effect.fail(
          new ConfigError({
            path: configPath,
            message: `${label} ("${meta.id}"): \`check\` must be a function (ctx) => matches`,
          }),
        ),
      onSome: ({ check }) =>
        Effect.succeed<IdiomRule>({
          id: meta.id,
          defaultSeverity: meta.defaultSeverity,
          description: meta.description,
          fixHint: meta.fixHint,
          check: failClosed(meta.id, check),
        }),
    })
  })

const decodeArray = (
  configPath: string,
  label: string,
  raw: unknown,
): Effect.Effect<ReadonlyArray<IdiomRule>, ConfigError> =>
  Array.isArray(raw)
    ? Effect.forEach(raw, (entry, index) => decodeOne(configPath, `${label}[${index}]`, entry), { concurrency: 1 })
    : Effect.fail(
        new ConfigError({ path: configPath, message: `${label} must be an array of rules` }),
      )

/** One plugged pack: `{ name, rules }` — the same shape the shipped library
 *  exports, decodable from a plain object too. */
const decodePack = (
  configPath: string,
  index: number,
  raw: unknown,
): Effect.Effect<ReadonlyArray<IdiomRule>, ConfigError> =>
  Option.match(decodePackShape(raw), {
    onNone: () =>
      Effect.fail(
        new ConfigError({
          path: configPath,
          message: `rulePacks[${index}] must be { name, rules } — import a shipped pack or shape your own`,
        }),
      ),
    onSome: (pack) => decodeArray(configPath, `rulePacks[${index}] ("${pack.name}")`, pack.rules),
  })

/**
 * The config module's whole rule registry: `rulePacks` ∪ `customRules` named
 * exports, every entry validated + fail-closed-wrapped, duplicate ids
 * rejected (two rules answering to one id would double-report and make
 * severity overrides ambiguous). Absent exports mean an empty registry — a
 * config that names no rules arms none.
 */
export const decodeRegistry = (
  configPath: string,
  module: { readonly rulePacks?: unknown; readonly customRules?: unknown },
): Effect.Effect<ReadonlyArray<IdiomRule>, ConfigError> =>
  Effect.gen(function* () {
    const packs = yield* module.rulePacks === undefined
      ? Effect.succeed<ReadonlyArray<IdiomRule>>([])
      : Array.isArray(module.rulePacks)
        ? Effect.map(
            Effect.forEach(module.rulePacks, (pack, index) =>
              decodePack(configPath, index, pack),
              { concurrency: 1 },
            ),
            (nested) => nested.flat(),
          )
        : Effect.fail(
            new ConfigError({ path: configPath, message: "rulePacks must be an array of packs" }),
          )
    const custom = yield* module.customRules === undefined
      ? Effect.succeed<ReadonlyArray<IdiomRule>>([])
      : decodeArray(configPath, "customRules", module.customRules)

    const registry = [...packs, ...custom]
    const duplicates = [
      ...new Set(
        registry
          .map((rule) => String(rule.id))
          .filter((id, index, ids) => ids.indexOf(id) !== index),
      ),
    ]
    if (duplicates.length > 0) {
      return yield* Effect.fail(
        new ConfigError({
          path: configPath,
          message: `duplicate rule id(s) across rulePacks/customRules: ${duplicates.join(", ")}`,
        }),
      )
    }
    return registry
  })
