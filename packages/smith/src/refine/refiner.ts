import { Tool, Toolkit } from "@effect/ai"
import { Array as Arr, Effect, Option, Ref, Schema } from "effect"
import {
  DEFAULT_SPEC_LIMITS,
  encodeSpecDocText,
  Failure,
  FileSystem,
  SpecDoc,
  specSlug,
  uniqueSlug,
} from "@xandreed/engine"
import type { AgentConfig, SpecSlug } from "@xandreed/engine"
import {
  Glob,
  Grep,
  Ls,
  makeSmithCodingHandlers,
  ReadFile,
} from "../implementor/codingToolkit.js"
import { specRefinerPrompt } from "./refinerPrompt.js"

/** Where a workspace's specs live, relative to its root. */
export const SPECS_DIR = ".efferent/specs"

/**
 * The refiner's ONE write: propose (or wholly replace) the spec draft.
 * Schema-validated at the tool boundary; the handler encodes and writes
 * `.efferent/specs/<slug>.md` with `status: draft`. The human locks —
 * never this tool. (Re-homed from the old line onto the engine.)
 */
export const ProposeSpec = Tool.make("propose_spec", {
  description:
    "Propose the spec draft — every call REPLACES the whole draft (same file, same slug, for the entire session). goal: one imperative paragraph. acceptance: verifiable criteria — machine-checkable ones MUST have a matching checks entry. checks: {name, command} pairs where the command is ONE line of shell that exits 0 iff the criterion holds, and must FAIL on the workspace as it is NOW (red-first). constraints: what must not change (unattended assumptions go here, prefixed 'assumption:'). nonGoals: explicit scope fences. Returns {slug, path, status: 'draft'} — only the human can lock it.",
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

/** Read-only exploration + the one write. */
export const specRefinerToolkit = Toolkit.make(ReadFile, Grep, Glob, Ls, ProposeSpec)

export interface SpecRefinerOptions {
  /** Refine an EXISTING spec in place (resume); absent ⇒ mint from the first goal. */
  readonly slug?: SpecSlug
  /** Called after each successful propose — drivers re-read the draft. */
  readonly onProposed?: (slug: SpecSlug, path: string) => Effect.Effect<void>
}

/**
 * The refiner handler record. Read tools reuse the smith coding handlers
 * (bashless subset); `propose_spec` validates → encodes → writes the draft.
 * Slug identity is minted ONCE per session — the model never owns identity.
 * Exported separately from the Layer so tests drive the handlers directly.
 */
export const makeSpecRefinerHandlers = (cwd: string, options: SpecRefinerOptions = {}) =>
  Effect.gen(function* () {
    const coding = yield* makeSmithCodingHandlers(cwd)
    const fs = yield* FileSystem
    const slugRef = yield* Ref.make(Option.fromNullable(options.slug))

    const mintSlug = (goal: string): Effect.Effect<SpecSlug> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(slugRef)
        if (Option.isSome(existing)) return existing.value
        const entries = yield* fs
          .list(`${cwd}/${SPECS_DIR}`)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
        const taken = new Set(entries.map((name) => name.replace(/\.md$/, "")))
        const minted = uniqueSlug(specSlug(goal), (candidate) => taken.has(candidate))
        yield* Ref.set(slugRef, Option.some(minted))
        return minted
      })

    return specRefinerToolkit.of({
      read_file: coding.read_file,
      grep: coding.grep,
      glob: coding.glob,
      ls: coding.ls,
      propose_spec: (params: {
        readonly goal: string
        readonly acceptance: ReadonlyArray<string>
        readonly constraints?: ReadonlyArray<string> | undefined
        readonly nonGoals?: ReadonlyArray<string> | undefined
        readonly checks?:
          | ReadonlyArray<{ readonly name: string; readonly command: string }>
          | undefined
        readonly maxAttempts?: number | undefined
        readonly budgetMinutes?: number | undefined
      }) =>
        Effect.gen(function* () {
          // A check command is EXACT shell — never normalized. One line per
          // check; multi-line scripts bounce as a teachable tool failure.
          const multiline = (params.checks ?? []).find((check) => /[\r\n]/.test(check.command))
          if (multiline !== undefined) {
            return yield* Effect.fail({
              error: "InvalidSpec",
              message: `check "${multiline.name}" has a multi-line command — make it a single line (join statements with ';', or move the logic into a test file and run that)`,
            })
          }
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
            Effect.mapError((error) => ({ error: "InvalidSpec", message: String(error) })),
          )
          const path = `${cwd}/${SPECS_DIR}/${slug}.md`
          const dir = `${cwd}/${SPECS_DIR}`
          yield* fs.mkdir(dir).pipe(Effect.catchAll(() => Effect.void))
          yield* fs.write(path, encodeSpecDocText(doc)).pipe(
            Effect.mapError((error) => ({ error: "SpecWriteFailed", message: String(error) })),
          )
          yield* options.onProposed?.(slug, path) ?? Effect.void
          return { slug: String(slug), path, status: "draft" }
        }),
    })
  })

/** The refiner as an engine AgentConfig. The workspace's standing RULES file
 *  (AGENTS.md convention — the human's instructions) and the forge-history
 *  lessons (foundry's deterministic memory) both ride the system prompt so
 *  the SPEC respects the house rules and addresses recurring gate
 *  rejections — constraints and checks born from evidence, not vibes. */
export const specRefinerAgentConfig = (
  cwd: string,
  options: {
    readonly unattended: boolean
    readonly lessons?: Option.Option<string>
    readonly rules?: Option.Option<string>
  } = { unattended: false },
): AgentConfig<(typeof specRefinerToolkit)["tools"]> => ({
  system: [
    specRefinerPrompt(cwd, options),
    ...Option.toArray(options.rules ?? Option.none()),
    ...Option.toArray(
      Option.map(
        options.lessons ?? Option.none(),
        (text) =>
          `# Past forge history in this workspace\n${text}\nWhen a lesson is relevant to this spec, encode it as a CONSTRAINT or a machine CHECK — the next run should not bounce on a known failure.`,
      ),
    ),
  ].join("\n\n"),
  toolkit: specRefinerToolkit,
  // 32, not 16: exploring a real codebase before proposing (ls + read_file
  // across dozens of modules) ate 16 steps with no spec yet — the run hit
  // the cap SILENTLY and read as a hang (live-caught on a Python port).
  // The cap still bounds one message's spend; the session persists, so a
  // follow-up message continues from the same context.
  maxSteps: 32,
})
