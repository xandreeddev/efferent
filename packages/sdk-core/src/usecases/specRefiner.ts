import { Tool, Toolkit } from "@effect/ai"
import { Array as Arr, Effect, Option, Ref, Schema } from "effect"
import { Failure } from "../entities/Failure.js"
import { DEFAULT_SPEC_LIMITS, SpecDoc } from "../entities/SpecDoc.js"
import type { SpecSlug } from "../entities/SpecDoc.js"
import { FileSystem } from "../ports/FileSystem.js"
import type { AgentConfig } from "./agentConfig.js"
import { Glob, Grep, Ls, makeCodingHandlers, ReadFile } from "./codingToolkit.js"
import { encodeSpecDocText, specSlug, uniqueSlug } from "./specCodec.js"
import { SPEC_REFINER_PROMPT_VERSION, specRefinerPrompt } from "../prompts/specRefiner.js"

/** Where a workspace's specs live, relative to its root. */
export const SPECS_DIR = ".efferent/specs"

/**
 * The refiner's ONE write: propose (or wholly replace) the spec draft.
 * Schema-validated at the tool boundary; the handler encodes and writes
 * `.efferent/specs/<slug>.md` with `status: draft`. The human locks —
 * never this tool.
 */
export const ProposeSpec = Tool.make("propose_spec", {
  description:
    "Propose the spec draft (or replace the current draft wholly). goal: one imperative paragraph. acceptance: verifiable criteria — machine-checkable ones MUST have a matching checks entry. checks: {name, command} pairs where the command exits 0 iff the criterion holds. constraints: what must not change (unattended assumptions go here, prefixed 'assumption:'). nonGoals: explicit scope fences.",
  parameters: {
    goal: Schema.String.annotations({ description: "One imperative paragraph." }),
    acceptance: Schema.Array(Schema.String).annotations({
      description: "Verifiable acceptance criteria.",
    }),
    constraints: Schema.optional(Schema.Array(Schema.String)),
    nonGoals: Schema.optional(Schema.Array(Schema.String)),
    checks: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String, command: Schema.String })),
    ),
    maxAttempts: Schema.optional(
      Schema.Number.annotations({ description: "Forge attempts, 1..10 (default 3)." }),
    ),
    budgetMinutes: Schema.optional(
      Schema.Number.annotations({ description: "Wall-clock budget (default 15)." }),
    ),
  },
  success: Schema.Struct({
    slug: Schema.String,
    path: Schema.String,
    status: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

/** Read-only exploration + the one write. The same toolkit at every refine depth. */
export const specRefinerToolkit = Toolkit.make(ReadFile, Grep, Glob, Ls, ProposeSpec)

export interface SpecRefinerOptions {
  /** Refine an EXISTING spec in place (resume); absent ⇒ mint from the first goal. */
  readonly slug?: SpecSlug
  /** Called after each successful propose — drivers re-read the draft for their UI. */
  readonly onProposed?: (slug: SpecSlug, path: string) => Effect.Effect<void>
}

/**
 * The refiner handler record. Read tools reuse the coding handlers (same
 * ports, bash off); `propose_spec` validates → encodes → writes the draft
 * file. Slug identity is minted ONCE per session (first propose wins; later
 * proposals rewrite the same file) — the model never owns identity.
 * Exported separately from the Layer so tests drive the handlers directly.
 */
export const makeSpecRefinerHandlers = (cwd: string, options: SpecRefinerOptions = {}) =>
  Effect.gen(function* () {
      const coding = yield* makeCodingHandlers({
        rootDir: cwd,
        displayRoot: cwd,
        enforceWrite: false,
        allowBash: false,
      })
      const fs = yield* FileSystem
      const slugRef = yield* Ref.make(Option.fromNullable(options.slug))

      const mintSlug = (goal: string): Effect.Effect<SpecSlug> =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(slugRef)
          if (Option.isSome(existing)) return existing.value
          const entries = yield* fs
            .list(`${cwd}/${SPECS_DIR}`, { recursive: false })
            .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<{ path: string }>)))
          const taken = new Set(
            entries.map((entry) => entry.path.split("/").at(-1)?.replace(/\.md$/, "") ?? ""),
          )
          const minted = uniqueSlug(specSlug(goal), (candidate) => taken.has(candidate))
          yield* Ref.set(slugRef, Option.some(minted))
          return minted
        })

      return {
        read_file: coding.read_file,
        grep: coding.grep,
        glob: coding.glob,
        ls: coding.ls,
        propose_spec: (params: {
          readonly goal: string
          readonly acceptance: ReadonlyArray<string>
          readonly constraints?: ReadonlyArray<string> | undefined
          readonly nonGoals?: ReadonlyArray<string> | undefined
          readonly checks?: ReadonlyArray<{ readonly name: string; readonly command: string }> | undefined
          readonly maxAttempts?: number | undefined
          readonly budgetMinutes?: number | undefined
        }) =>
          Effect.gen(function* () {
            const slug = yield* mintSlug(params.goal)
            const candidate = {
              slug: String(slug),
              status: "draft",
              created: new Date().toISOString(),
              goal: params.goal,
              acceptance: params.acceptance,
              constraints: params.constraints ?? [],
              nonGoals: params.nonGoals ?? [],
              checks: Arr.map(params.checks ?? [], (check) => ({
                name: check.name,
                command: check.command,
              })),
              limits: {
                maxAttempts: params.maxAttempts ?? DEFAULT_SPEC_LIMITS.maxAttempts,
                budgetMinutes: params.budgetMinutes ?? DEFAULT_SPEC_LIMITS.budgetMinutes,
              },
              gates: {},
            }
            const doc = yield* Schema.decodeUnknown(SpecDoc)(candidate).pipe(
              Effect.mapError((error) => ({
                error: "InvalidSpec",
                message: String(error),
              })),
            )
            const path = `${cwd}/${SPECS_DIR}/${slug}.md`
            yield* fs.write(path, encodeSpecDocText(doc)).pipe(
              Effect.mapError((error) => ({
                error: "SpecWriteFailed",
                message: String(error),
              })),
            )
            yield* (options.onProposed?.(slug, path) ?? Effect.void)
            return { slug: String(slug), path, status: "draft" }
          }),
      }
    })

/** The refiner toolkit's handler Layer over {@link makeSpecRefinerHandlers}. */
export const specRefinerToolkitLayer = (cwd: string, options: SpecRefinerOptions = {}) =>
  specRefinerToolkit.toLayer(makeSpecRefinerHandlers(cwd, options))

/** The refiner as an AgentConfig — drivers run it with `runAgent` like any agent. */
export const specRefinerAgentConfig = (
  cwd: string,
  options: { readonly unattended: boolean } = { unattended: false },
): AgentConfig<typeof specRefinerToolkit extends Toolkit.Toolkit<infer T> ? T : never> => ({
  key: `spec-refiner:${cwd}`,
  prompt: {
    name: "spec-refiner",
    version: SPEC_REFINER_PROMPT_VERSION,
    text: specRefinerPrompt(cwd, options),
  },
  toolkit: specRefinerToolkit,
})
