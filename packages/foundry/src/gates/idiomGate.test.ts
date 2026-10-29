import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as path from "node:path"
import { RuleId } from "../domain/Brands.js"
import { RuleConfig } from "../domain/Rules.js"
import type { Workspace } from "../ports/Gate.js"
import { makeIdiomGate } from "./idiomGate.js"
import { allBuiltinRules } from "./rules/index.js"
import { TsProjectCachedLive } from "./TsProject.port.js"

const rootDir = path.resolve(import.meta.dir, "../../fixtures/idioms")
const ws: Workspace = { rootDir, files: [] }

const configFor = (rules: ReadonlyArray<string>, include: ReadonlyArray<string>) =>
  rules.map((rule) =>
    Schema.decodeUnknownSync(RuleConfig)({ rule, include: [...include] }),
  )

const findingsFor = (rules: ReadonlyArray<string>, include: ReadonlyArray<string>) =>
  Effect.runPromise(
    makeIdiomGate(allBuiltinRules, configFor(rules, include), "tsconfig.json")
      .run(ws)
      .pipe(Effect.provide(TsProjectCachedLive)),
  )

const at = (findings: Awaited<ReturnType<typeof findingsFor>>) =>
  findings
    .map((f) => ({
      rule: String(f.rule),
      file: Option.match(f.location, { onNone: () => "?", onSome: (l) => String(l.file) }),
      line: Option.match(f.location, { onNone: () => 0, onSome: (l) => l.line }),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

describe("effect-idioms gate over fixtures", () => {
  test("effect/no-let finds the let, and nothing in clean.ts", async () => {
    const findings = await findingsFor(["effect/no-let"], ["**/*.ts"])
    expect(at(findings)).toEqual([{ rule: "effect/no-let", file: "noLet.ts", line: 2 }])
  })

  test("effect/no-try-catch finds try, throw, and .catch()", async () => {
    const findings = await findingsFor(["effect/no-try-catch"], ["tryCatch.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 2 },
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 10 },
      { rule: "effect/no-try-catch", file: "tryCatch.ts", line: 13 },
    ])
  })

  test("effect/no-nullable-return is type-aware: declared AND inferred nullable unions", async () => {
    const findings = await findingsFor(["effect/no-nullable-return"], ["nullableReturn.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-nullable-return", file: "nullableReturn.ts", line: 1 },
      { rule: "effect/no-nullable-return", file: "nullableReturn.ts", line: 4 },
    ])
    expect(findings.some((f) => f.message.includes("string | undefined"))).toBe(true)
  })

  test("effect/match-over-tag-switch flags the switch and the ladder, not the single guard", async () => {
    const findings = await findingsFor(["effect/match-over-tag-switch"], ["tagSwitch.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 6 },
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 15 },
    ])
  })

  test("effect/no-as-any flags `as any` and the unknown-laundering chain", async () => {
    const findings = await findingsFor(["effect/no-as-any"], ["asAny.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-as-any", file: "asAny.ts", line: 1 },
      { rule: "effect/no-as-any", file: "asAny.ts", line: 3 },
    ])
  })

  test("effect/branded-id-fields flags unbranded id-shaped fields, through check chains, wrappers and local consts", async () => {
    const findings = await findingsFor(["effect/branded-id-fields"], ["unbrandedId.ts"])
    // Not the `Branded` struct: a brand inside a wrapper, a pipe on a branded
    // const, or an id declared elsewhere passes.
    expect(at(findings)).toEqual(
      [4, 5, 16, 17, 18, 19, 20, 21, 22, 23, 24].map((line) => ({ rule: "effect/branded-id-fields", file: "unbrandedId.ts", line })),
    )
  })

  test("effect/no-loop-statements flags every loop kind", async () => {
    const findings = await findingsFor(["effect/no-loop-statements"], ["loops.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-loop-statements", file: "loops.ts", line: 3 },
      { rule: "effect/no-loop-statements", file: "loops.ts", line: 6 },
    ])
  })

  test("effect/no-parallel-interface flags the Schema-shadowing interface only", async () => {
    const findings = await findingsFor(["effect/no-parallel-interface"], ["parallelInterface.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-parallel-interface", file: "parallelInterface.ts", line: 7 },
    ])
  })

  test("quality/no-skipped-tests flags skip/todo/x-prefixed runners AND .only", async () => {
    const findings = await findingsFor(["quality/no-skipped-tests"], ["skippedTests.ts"])
    expect(at(findings)).toEqual([
      { rule: "quality/no-skipped-tests", file: "skippedTests.ts", line: 7 },
      { rule: "quality/no-skipped-tests", file: "skippedTests.ts", line: 8 },
      { rule: "quality/no-skipped-tests", file: "skippedTests.ts", line: 9 },
      { rule: "quality/no-skipped-tests", file: "skippedTests.ts", line: 10 },
    ])
    expect(findings.map((f) => f.message).at(-1)).toContain("every OTHER test")
  })

  test("effect/no-as-never flags the never-cast and the never-laundering chain", async () => {
    const findings = await findingsFor(["effect/no-as-never"], ["asNever.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-as-never", file: "asNever.ts", line: 2 },
      { rule: "effect/no-as-never", file: "asNever.ts", line: 4 },
    ])
    expect(findings.map((f) => f.message)).toEqual([
      "`as never` launders the type like `as any`",
      "`as never as T` launders the type like `as unknown as T`",
    ])
  })

  test("a rule's boundary drops what the rule tolerates there: `as never`, never `as never as T`", async () => {
    const config = [Schema.decodeUnknownSync(RuleConfig)({ rule: "effect/no-as-never", include: ["asNever.ts"], boundary: ["asNever.ts"] })]
    const findings = await Effect.runPromise(
      makeIdiomGate(allBuiltinRules, config, "tsconfig.json").run(ws).pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(at(findings)).toEqual([{ rule: "effect/no-as-never", file: "asNever.ts", line: 4 }])
  })

  test("effect/no-json-parse flags JSON.parse, called or passed, and not the Schema decode", async () => {
    const findings = await findingsFor(["effect/no-json-parse"], ["jsonParse.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-json-parse", file: "jsonParse.ts", line: 3 },
      { rule: "effect/no-json-parse", file: "jsonParse.ts", line: 4 },
    ])
  })

  test("effect/no-sync-codec flags the throwing codecs, not the Result or Effect forms", async () => {
    const findings = await findingsFor(["effect/no-sync-codec"], ["syncCodec.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-sync-codec", file: "syncCodec.ts", line: 4 },
      { rule: "effect/no-sync-codec", file: "syncCodec.ts", line: 5 },
    ])
  })

  test("effect/no-unknown-json flags open record and JSON schemas, not one passed to Schema.encode*, nor a bare Schema.Unknown", async () => {
    const findings = await findingsFor(["effect/no-unknown-json"], ["unknownJson.ts"])
    expect(at(findings)).toEqual([3, 4, 5].map((line) => ({ rule: "effect/no-unknown-json", file: "unknownJson.ts", line })))
    expect(findings.map((f) => f.message)).toEqual([
      "`Schema.Record(Schema.String, Schema.Unknown)` checks the keys and lets every value through",
      "`Schema.fromJsonString(Schema.Unknown)` checks that the text is JSON, not what it holds",
      "`Schema.Record(Schema.String, Schema.Unknown)` checks the keys and lets every value through",
    ])
  })

  test("effect/no-record-cast flags casts to an open record or an object literal type, not to typed values", async () => {
    const findings = await findingsFor(["effect/no-record-cast"], ["recordCast.ts"])
    expect(at(findings)).toEqual([3, 4, 5].map((line) => ({ rule: "effect/no-record-cast", file: "recordCast.ts", line })))
    expect(findings.map((f) => f.message)).toEqual([
      "`as Record<string, unknown>` asserts an object that nothing checked",
      "`as Record<string, any>` asserts an object that nothing checked",
      "`as { … }` asserts an object shape that nothing checked",
    ])
  })

  test("the decoding rules find nothing in the other fixtures, nor in test scaffolding the profile excludes", async () => {
    const config = ["effect/no-unknown-json", "effect/no-record-cast"].map((rule) =>
      Schema.decodeUnknownSync(RuleConfig)({ rule, include: ["**/*.ts"], exclude: ["**/*.testing.ts"] }),
    )
    const findings = await Effect.runPromise(
      makeIdiomGate(allBuiltinRules, config, "tsconfig.json").run(ws).pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect([...new Set(at(findings).map((f) => `${f.rule} ${f.file}`))]).toEqual([
      "effect/no-record-cast recordCast.ts",
      "effect/no-unknown-json unknownJson.ts",
    ])
    expect(await findingsFor(["effect/no-unknown-json", "effect/no-record-cast"], ["decoding.testing.ts"])).toHaveLength(2)
  })

  test("effect/no-provider-namespace flags a provider's key written, typed, destructured or read, not the word as a value or a name", async () => {
    const findings = await findingsFor(["effect/no-provider-namespace"], ["providerNamespace.ts"])
    expect(at(findings)).toEqual([3, 4, 4, 5, 6, 7, 8].map((line) => ({ rule: "effect/no-provider-namespace", file: "providerNamespace.ts", line })))
    expect(findings.map((f) => f.message)).toEqual(
      ["anthropic", "openai", "google", "router", "anthropic", "openai", "google"].map((key) => `\`${key}\` names a provider's namespace`),
    )
    expect(await findingsFor(["effect/no-provider-namespace"], ["**/*.ts"])).toHaveLength(7)
  })

  test("effect/no-cause-pretty-data flags Cause.pretty kept as data, not as an Effect.log* argument", async () => {
    const findings = await findingsFor(["effect/no-cause-pretty-data"], ["causePretty.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-cause-pretty-data", file: "causePretty.ts", line: 4 },
      { rule: "effect/no-cause-pretty-data", file: "causePretty.ts", line: 8 },
    ])
  })

  test("effect/no-effect-promise flags Effect.promise, not Effect.tryPromise", async () => {
    const findings = await findingsFor(["effect/no-effect-promise"], ["effectPromise.ts"])
    expect(at(findings)).toEqual([{ rule: "effect/no-effect-promise", file: "effectPromise.ts", line: 3 }])
  })

  test("effect/no-promise-all flags Promise.all and allSettled", async () => {
    const findings = await findingsFor(["effect/no-promise-all"], ["promiseAll.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-promise-all", file: "promiseAll.ts", line: 3 },
      { rule: "effect/no-promise-all", file: "promiseAll.ts", line: 4 },
    ])
  })

  test("effect/callback-buffer-size is type-aware: a literal or a typed options value naming bufferSize passes", async () => {
    const findings = await findingsFor(["effect/callback-buffer-size"], ["callbackBufferSize.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/callback-buffer-size", file: "callbackBufferSize.ts", line: 4 },
      { rule: "effect/callback-buffer-size", file: "callbackBufferSize.ts", line: 5 },
    ])
  })

  test("effect/no-process-env flags process.env in code, not in comments", async () => {
    const findings = await findingsFor(["effect/no-process-env"], ["processEnv.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-process-env", file: "processEnv.ts", line: 3 },
      { rule: "effect/no-process-env", file: "processEnv.ts", line: 4 },
    ])
  })

  test("effect/no-ambient-time-random flags the wall clock and unseeded generators, not Clock, Random or new Date(t)", async () => {
    const findings = await findingsFor(["effect/no-ambient-time-random"], ["ambientTimeRandom.ts"])
    expect(at(findings)).toEqual([4, 5, 6, 7, 8].map((line) => ({ rule: "effect/no-ambient-time-random", file: "ambientTimeRandom.ts", line })))
  })

  test("effect/no-locale-compare flags localeCompare, not Order.String", async () => {
    const findings = await findingsFor(["effect/no-locale-compare"], ["localeCompare.ts"])
    expect(at(findings)).toEqual([{ rule: "effect/no-locale-compare", file: "localeCompare.ts", line: 3 }])
  })

  test("effect/require-sort-comparator flags sort/toSorted without an order", async () => {
    const findings = await findingsFor(["effect/require-sort-comparator"], ["sortComparator.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/require-sort-comparator", file: "sortComparator.ts", line: 3 },
      { rule: "effect/require-sort-comparator", file: "sortComparator.ts", line: 4 },
    ])
  })

  test("effect/no-instanceof-tagged-error is type-aware: tagged classes only, never Error or Date", async () => {
    const findings = await findingsFor(["effect/no-instanceof-tagged-error"], ["instanceofTaggedError.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-instanceof-tagged-error", file: "instanceofTaggedError.ts", line: 6 },
      { rule: "effect/no-instanceof-tagged-error", file: "instanceofTaggedError.ts", line: 7 },
    ])
  })

  test("effect/no-silent-ignore flags a dropped failure that nothing logs, not a logged or narrowed one", async () => {
    const findings = await findingsFor(["effect/no-silent-ignore"], ["silentIgnore.ts"])
    expect(at(findings)).toEqual([4, 5, 6, 7, 8].map((line) => ({ rule: "effect/no-silent-ignore", file: "silentIgnore.ts", line })))
  })

  test("effect/no-stringified-cause is type-aware: a failure turned to text inside a tagged error, not a number or plain data", async () => {
    const findings = await findingsFor(["effect/no-stringified-cause"], ["stringifiedCause.ts"])
    expect(at(findings)).toEqual([6, 7, 8, 9].map((line) => ({ rule: "effect/no-stringified-cause", file: "stringifiedCause.ts", line })))
  })

  test("effect/no-error-code-compare flags a code compared outside the module that declares it, not a foreign code", async () => {
    const findings = await findingsFor(["effect/no-error-code-compare"], ["errorCode.ts", "errorCodeCompare.ts"])
    expect(at(findings)).toEqual([
      { rule: "effect/no-error-code-compare", file: "errorCodeCompare.ts", line: 3 },
      { rule: "effect/no-error-code-compare", file: "errorCodeCompare.ts", line: 4 },
    ])
  })

  test("effect/prefer-effect-fn flags exported functions and service methods that only return Effect.gen", async () => {
    const findings = await findingsFor(["effect/prefer-effect-fn"], ["effectFn.ts"])
    expect(at(findings)).toEqual([3, 4, 7].map((line) => ({ rule: "effect/prefer-effect-fn", file: "effectFn.ts", line })))
  })

  test("effect/require-concurrency-option flags forEach and all without a concurrency, data-first or data-last", async () => {
    const findings = await findingsFor(["effect/require-concurrency-option"], ["concurrencyOption.ts"])
    expect(at(findings)).toEqual([4, 5, 6].map((line) => ({ rule: "effect/require-concurrency-option", file: "concurrencyOption.ts", line })))
  })

  test("effect/no-option-unwrap flags getOrNull and getOrUndefined, called or passed", async () => {
    const findings = await findingsFor(["effect/no-option-unwrap"], ["optionUnwrap.ts"])
    expect(at(findings)).toEqual([4, 5, 6].map((line) => ({ rule: "effect/no-option-unwrap", file: "optionUnwrap.ts", line })))
  })

  test("effect/match-over-tag-switch flags ternary chains and the type, role and mode discriminants, not a single guard", async () => {
    const findings = await findingsFor(["effect/match-over-tag-switch"], ["discriminantChains.ts"])
    expect(at(findings)).toEqual([5, 7, 9].map((line) => ({ rule: "effect/match-over-tag-switch", file: "discriminantChains.ts", line })))
  })

  test("a boundary tolerates the later match-over-tag-switch checks, never the switch or ladder on _tag", async () => {
    const config = [
      Schema.decodeUnknownSync(RuleConfig)({
        rule: "effect/match-over-tag-switch",
        include: ["tagSwitch.ts", "discriminantChains.ts"],
        boundary: ["tagSwitch.ts", "discriminantChains.ts"],
      }),
    ]
    const findings = await Effect.runPromise(
      makeIdiomGate(allBuiltinRules, config, "tsconfig.json").run(ws).pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(at(findings)).toEqual([
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 6 },
      { rule: "effect/match-over-tag-switch", file: "tagSwitch.ts", line: 15 },
    ])
  })

  test("architecture/role-suffix-required flags a file whose name states no role", async () => {
    const findings = await findingsFor(["architecture/role-suffix-required"], ["noLet.ts"])
    expect(at(findings)).toEqual([{ rule: "architecture/role-suffix-required", file: "noLet.ts", line: 1 }])
    expect(findings.map((f) => f.message)).toEqual(["`noLet.ts` has no role suffix"])
  })

  test("a rule's allow list skips the files it names, and an entry that excuses nothing fails", async () => {
    const run = (allow: ReadonlyArray<string>) =>
      Effect.runPromise(
        makeIdiomGate(
          allBuiltinRules,
          [Schema.decodeUnknownSync(RuleConfig)({ rule: "effect/no-let", include: ["noLet.ts", "clean.ts"], allow })],
          "tsconfig.json",
        ).run(ws).pipe(Effect.provide(TsProjectCachedLive)),
      )
    expect(await run(["noLet.ts"])).toEqual([])
    const stale = await run(["noLet.ts", "clean.ts", "gone.ts"])
    expect(stale.map((f) => [String(f.rule), f.message, Option.isNone(f.location)])).toEqual([
      ["effect/no-let", 'the allow list entry "clean.ts" passes this rule now', true],
      ["effect/no-let", 'the allow list entry "gone.ts" names no file this rule checks (renamed, deleted or outside its include)', true],
    ])
  })

  test("quality/no-empty-catch flags the swallow, not the handled catch", async () => {
    const findings = await findingsFor(["quality/no-empty-catch"], ["emptyCatch.ts"])
    expect(at(findings)).toEqual([
      { rule: "quality/no-empty-catch", file: "emptyCatch.ts", line: 4 },
    ])
  })

  test("clean.ts passes every rule but the role suffix (a fixture's name states no role)", async () => {
    const findings = await findingsFor(
      allBuiltinRules.map((r) => String(r.id)).filter((id) => id !== "architecture/role-suffix-required"),
      ["clean.ts"],
    )
    expect(findings).toEqual([])
  })

  test("include/exclude globs scope rules per path", async () => {
    const config = [
      Schema.decodeUnknownSync(RuleConfig)({
        rule: "effect/no-let",
        include: ["**/*.ts"],
        exclude: ["noLet.ts"],
      }),
    ]
    const findings = await Effect.runPromise(
      makeIdiomGate(allBuiltinRules, config, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(findings).toEqual([])
  })

  test("an unknown rule id in config is a GateCrash (config error, fail-closed)", async () => {
    const config = [
      Schema.decodeUnknownSync(RuleConfig)({ rule: RuleId.make("effect/no-such-rule") }),
    ]
    const exit = await Effect.runPromiseExit(
      makeIdiomGate(allBuiltinRules, config, "tsconfig.json")
        .run(ws)
        .pipe(Effect.provide(TsProjectCachedLive)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
