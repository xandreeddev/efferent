import { Effect, Layer, Match, Option, Schema } from "effect"
import * as path from "node:path"
import type { WorkspaceError } from "../domain/Errors.js"
import { RuleConfig } from "../domain/Rules.js"
import { ForgeLimits, Spec } from "../domain/Spec.js"
import { forge } from "../pipeline/forge.js"
import type { ForgeResult } from "../pipeline/forge.js"
import { makeIdiomGate } from "../gates/idiomGate.js"
import { builtinRules } from "../gates/rules/index.js"
import { makeTypecheckGate } from "../gates/typecheckGate.js"
import { TsProjectFreshLive } from "../gates/TsProject.js"
import { ClaudeCliImplementorLive } from "../adapters/claudeImplementor.js"
import { makeFileRunSink } from "../adapters/fileRunSink.js"
import { makeScriptedImplementor } from "../adapters/scriptedImplementor.js"
import {
  snapshotWorkspace,
  withTempWorkspace,
  writeWorkspaceFile,
} from "../adapters/tempWorkspace.js"
import { renderReport } from "./report.js"

const DEMO_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      moduleResolution: "bundler",
      module: "esnext",
      target: "esnext",
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
)}\n`

const spec = new Spec({
  goal: "Implement a stringStats module at src/stringStats.ts: `longest(words): Option<string>` (the longest word, None for an empty list) and `histogram(words): ReadonlyMap<number, number>` (word-length counts). Effect idioms: no let, no nullable returns — absence is Option.",
  acceptance: [
    "longest returns Option<string>, never `string | undefined`",
    "no `let` bindings; state is folded",
    "the module typechecks strict",
  ],
  limits: new ForgeLimits({ maxAttempts: 4, budgetMillis: 15 * 60 * 1000 }),
})

/** Attempt 1: idiom violations (a `let`, a nullable return) → rank 0 fails.
 *  Attempt 2: idioms clean but a TS2322 → rank 0 passes, rank 1 fails.
 *  Attempt 3: clean → accepted. Three attempts, one per pipeline stage. */
const SCRIPT = [
  [
    {
      path: "src/stringStats.ts",
      content: [
        `export const longest = (words: ReadonlyArray<string>): string | undefined => {`,
        `  let best: string | undefined = undefined`,
        `  for (const word of words) {`,
        `    if (best === undefined || word.length > best.length) best = word`,
        `  }`,
        `  return best`,
        `}`,
        ``,
      ].join("\n"),
    },
  ],
  [
    {
      path: "src/stringStats.ts",
      content: [
        `import { Option } from "effect"`,
        ``,
        `export const longest = (words: ReadonlyArray<string>): Option.Option<string> => {`,
        `  const sorted = [...words].sort((a, b) => b.length - a.length)`,
        `  const best: string = sorted[0]`,
        `  return Option.fromNullable(best)`,
        `}`,
        ``,
      ].join("\n"),
    },
  ],
  [
    {
      path: "src/stringStats.ts",
      content: [
        `import { Option } from "effect"`,
        ``,
        `export const longest = (words: ReadonlyArray<string>): Option.Option<string> =>`,
        `  Option.fromNullable([...words].sort((a, b) => b.length - a.length)[0])`,
        ``,
        `export const histogram = (words: ReadonlyArray<string>): ReadonlyMap<number, number> =>`,
        `  words.reduce(`,
        `    (acc, word) => new Map(acc).set(word.length, (acc.get(word.length) ?? 0) + 1),`,
        `    new Map<number, number>(),`,
        `  )`,
        ``,
      ].join("\n"),
    },
  ],
]

const demoRules = [
  "effect/no-let",
  "effect/no-nullable-return",
  "effect/no-try-catch",
  "effect/no-as-any",
].map((rule) => Schema.decodeUnknownSync(RuleConfig)({ rule, include: ["src/**/*.ts"] }))

export type DemoImplementor = "scripted" | "claude"

const printRun = ({ artifact, run }: ForgeResult): number => {
  run.attempts.forEach((attempt) => {
    console.log(`\n── attempt ${attempt.attempt} ${"─".repeat(46)}`)
    console.log(renderReport(attempt.report))
    Option.map(attempt.feedback, (brief) =>
      console.log(`\nfeedback for the next attempt:\n${brief}`),
    )
  })
  console.log(
    `\noutcome: ${
      run.outcome._tag === "accepted"
        ? `ACCEPTED on attempt ${run.outcome.attempt}`
        : `REJECTED (${run.outcome.reason})`
    }`,
  )
  console.log(`artifact: ${artifact}`)
  return run.outcome._tag === "accepted" ? 0 : 1
}

/**
 * The key-free end-to-end: forge a module from a spec inside a throwaway
 * workspace, watch the pipeline reject attempts stage by stage, accept when
 * green. `--implementor claude` runs the same spec against a real agent.
 */
export const runDemo = (implementor: DemoImplementor): Effect.Effect<number, WorkspaceError> =>
  withTempWorkspace(path.join(process.cwd(), ".foundry", "demo"), (workspaceDir) =>
    Effect.gen(function* () {
      yield* writeWorkspaceFile(workspaceDir, "tsconfig.json", DEMO_TSCONFIG)
      const implementorLayer = Match.value(implementor).pipe(
        Match.when("scripted", () => makeScriptedImplementor(SCRIPT)),
        Match.when("claude", () => ClaudeCliImplementorLive),
        Match.exhaustive,
      )
      const result = yield* forge({
        spec,
        pipeline: {
          gates: [
            makeIdiomGate(builtinRules, demoRules, "tsconfig.json"),
            makeTypecheckGate("tsconfig.json"),
          ],
          policy: "staged",
        },
        workspaceDir,
        snapshot: snapshotWorkspace(workspaceDir),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TsProjectFreshLive,
            implementorLayer,
            makeFileRunSink(path.join(process.cwd(), ".foundry", "runs")),
          ),
        ),
        Effect.map(Option.some),
        Effect.catchTag("ImplementorError", (e) =>
          Effect.sync(() => console.error(`implementor failed: ${e.message}`)).pipe(
            Effect.as(Option.none<ForgeResult>()),
          ),
        ),
      )
      return Option.match(result, { onNone: () => 1, onSome: printRun })
    }),
  )
