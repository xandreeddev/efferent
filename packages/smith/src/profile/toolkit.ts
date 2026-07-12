import { Tool, Toolkit } from "@effect/ai"
import { Schema } from "effect"
import { Failure } from "@xandreed/engine"
import { Glob, Grep, LoadSkill, Ls, ReadFile } from "../implementor/codingToolkit.js"

/** The proposal as DATA — the tool's parameter shape and the draft.json
 *  codec are the same schema, so a locked draft is exactly what was
 *  proposed. */
export const ProfileProposal = Schema.Struct({
  packs: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
  customRules: Schema.optionalWith(
    Schema.Array(Schema.Struct({ filename: Schema.NonEmptyString, source: Schema.String })),
    { default: () => [] },
  ),
  rules: Schema.Array(
    Schema.Struct({
      rule: Schema.NonEmptyString,
      include: Schema.optional(Schema.Array(Schema.NonEmptyString)),
      exclude: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    }),
  ),
  checks: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        command: Schema.NonEmptyString,
        kind: Schema.optionalWith(Schema.Literal("test", "eval"), { default: () => "test" }),
        timeoutMs: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
          default: () => 300_000,
        }),
      }),
    ),
    { default: () => [] },
  ),
  boundaries: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        path: Schema.NonEmptyString,
        canImport: Schema.Array(Schema.String),
        externals: Schema.Array(Schema.String),
      }),
    ),
    { default: () => [] },
  ),
  doctrine: Schema.optionalWith(Schema.String, { default: () => "" }),
})
export type ProfileProposal = typeof ProfileProposal.Type

export interface ProfileDryRun {
  readonly draftDir: string
  readonly rules: ReadonlyArray<{ readonly rule: string; readonly findings: number }>
  readonly boundaryViolations: number
  readonly checks: ReadonlyArray<{ readonly name: string; readonly status: "green" | "red" }>
  readonly note: string
}

/** The draft a `propose_profile` call carries — pure data; custom rule CODE
 *  rides as source strings the session writes into the draft dir (the same
 *  trust posture as propose_spec, whose check commands also execute at
 *  propose time). */
export const ProposeProfile = Tool.make("propose_profile", {
  description:
    "Propose the workspace quality profile — every call REPLACES the whole draft. packs: shipped rule packs to vendor into the project ('effect' for Effect.ts idioms, 'effect-architecture' for Schema entities/use cases + Context.Tag ports + Layer adapters, 'quality' for paradigm-neutral anti-gate-gaming). customRules: additional rule modules as {filename, source} — plain TS exporting `rules` (load the gate-rule-authoring skill first). rules: which rule ids to ARM and where (ids must come from the chosen packs/custom modules). checks: the project's own authoritative scripts as {name, command, kind?, timeoutMs?} (bash -c, exit 0 = clean; kind 'eval' runs after tests). boundaries: dependency-direction layers. doctrine: the prose rules file body (markdown, no heading needed). The proposal is DRY-RUN against the workspace: the result carries per-rule finding counts (grandfathered at lock), boundary violations, and check statuses. Only the human locks.",
  parameters: {
    packs: Schema.optional(
      Schema.Array(Schema.String).annotations({
        description: 'Shipped packs to vendor: "effect", "quality", and/or "effect-architecture".',
      }),
    ),
    customRules: Schema.optional(
      Schema.Array(
        Schema.Struct({
          filename: Schema.String.annotations({
            description: "Module filename, e.g. my-rules.ts (written under .efferent/gates/).",
          }),
          source: Schema.String.annotations({
            description: "Full TS module source exporting `rules` (plain structural rule objects).",
          }),
        }),
      ),
    ),
    rules: Schema.Array(
      Schema.Struct({
        rule: Schema.String.annotations({ description: 'Rule id, e.g. "effect/no-let".' }),
        include: Schema.optional(Schema.Array(Schema.String)),
        exclude: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    checks: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          command: Schema.String,
          kind: Schema.optional(Schema.Literal("test", "eval")),
          timeoutMs: Schema.optional(Schema.Number),
        }),
      ),
    ),
    boundaries: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
          canImport: Schema.Array(Schema.String),
          externals: Schema.Array(Schema.String),
        }),
      ),
    ),
    doctrine: Schema.optional(
      Schema.String.annotations({
        description: "The prose rules-file body — what static analysis can't express.",
      }),
    ),
  },
  success: Schema.Struct({
    draftDir: Schema.String,
    rules: Schema.Array(
      Schema.Struct({ rule: Schema.String, findings: Schema.Number }),
    ),
    boundaryViolations: Schema.Number,
    checks: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal("green", "red"),
      }),
    ),
    note: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

/** Read-only exploration + skills + the one write. */
export const profileToolkit = Toolkit.make(ReadFile, Grep, Glob, Ls, LoadSkill, ProposeProfile)
