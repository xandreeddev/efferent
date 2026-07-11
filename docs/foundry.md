# Foundry — the factory loop + gate pipeline

`@xandreed/foundry` (`packages/foundry`) is the **factory model** from
Google's "The New SDLC With Vibe Coding" (Osmani/Saboo/Kartakis, May 2026),
built Effect-native: the developer's real output is not code but **the
system that produces code** — a spec, an implementor, chained deterministic
quality gates, typed feedback routed back into the loop, and guardrails.
`Agent = Model + Harness`; foundry is harness.

```
           ┌──────────────────────────────────────────────────┐
           │                    forge(spec)                   │
           │                                                  │
 spec ──▶  │  Implementor.implement ──▶ snapshot ──▶ pipeline │ ──▶ FactoryRun
           │        ▲                                  │      │     (artifact)
           │        └──── renderFeedback(report) ◀─────┘      │
           │              (typed findings → model brief)      │
           └──────────────────────────────────────────────────┘
              bounded by maxAttempts + wall-clock budget
```

## Why (the audit, 2026-07-07)

The existing runtime was vibe-coded and missed the Effect point. Quantified:
`Match` used 0 times (374 `if` in sdk-core); 28 `Option.` uses vs ~463
nullable unions (32 core functions RETURN nullables); 3 branded types in the
repo; ~346 `let`/~373 loops with `Effect.iterate` used 0 times; entities are
`Schema.Struct` + 96 parallel hand-written interfaces; ONE static rule total
(`banTryCatch.ts`); no linter; architecture direction by convention; an eval
suite with `scorers: []` typechecks and silently scores 0, and the declared
`threshold` is decorative (`run.ts` hardcodes 0.6).

Foundry's answer is structural: every one of those holes is either
**unrepresentable in its types** or **a failing finding in its gates** — and
foundry runs its own gates on its own source in CI (the dogfood is the
flagship demo).

## The domain (exemplary by construction)

- **Brands** (`domain/Brands.ts`), per the rubric in
  `docs/branded-types-roadmap.md`: `Score` (refined 0..1), `RuleId`
  (`namespace/name` pattern), `GateName`, `RunId` (UUID), `AttemptNumber`
  (positive int), `WorkspacePath` (workspace-relative, two mint points).
  Free-form text is deliberately unbranded.
- **Entities are `Schema.Class`** — the class IS the type, constructor, and
  Equal/Hash; interface drift is unrepresentable. Absence is
  `Schema.optionalWith(S, { as: "Option" })`: `Option` in memory, a plain
  omitted field on the wire.
- **Errors are `Schema.TaggedError`** (`GateCrash`, `ImplementorError`,
  `WorkspaceError`, `ConfigError`, `ProjectLoadError`) — they cross a
  serialization boundary (the persisted `FactoryRun`, model-readable
  feedback), so each carries its schema.
- **Verdicts make bad states unrepresentable**: `fail` REQUIRES a non-empty
  findings array ("failed with no reasons" cannot exist); `skip` carries the
  blocking stage's name, so a report accounts for every configured gate.
- **`EvalContract.ts`** is the evals-v2 contract: `scorers` is a
  `NonEmptyReadonlyArray` (an empty list no longer typechecks), `threshold`
  is a required branded `Score`, and `ScorerArgsV2` carries the
  **trajectory** — scorers judge the path, not just the answer.

## The gate abstraction

A gate is a **value** (like an eval `Scorer`) — pipelines are data:

```ts
interface Gate<R> {
  name: GateName
  kind: "static" | "typecheck" | "test" | "eval" | "judge"   // cost rank 0..4
  deterministic: boolean
  run: (ws: Workspace) => Effect<ReadonlyArray<Finding>, GateCrash, R>
}
```

Gates report findings; **the pipeline classifies** (fail iff any
error-severity finding — one rule, one place: `toVerdict`). `runPipeline`'s
default **staged** policy: within a cost rank run everything (maximize
feedback per expensive generation attempt); across ranks fail fast (never
run tests on code that doesn't typecheck). A gate that cannot RUN folds to a
`fail` verdict carrying a `foundry/gate-crashed` finding — **fail-closed,
never a silent pass** (the Verifier's discipline) — which is why
`runPipeline`'s error channel is `never`.

`renderFeedback` turns a report into the model-readable brief for the next
attempt: deterministic (stable sort, golden-tested), grouped per gate,
capped with exact overflow counts (the compaction-marker discipline), each
finding carrying its `fixHint`, plus a "not yet run (blocked)" note so the
model knows more checks are waiting.

## The gates (all over ONE shared `ts.Program`)

`TsProject` builds the program once per tsconfig (`SynchronizedRef`-memoized
for one-shot `check`; rebuilt per attempt in `forge` — `TsProjectFreshLive`
— because the implementor rewrites the workspace and a memoized program
would judge attempt N against attempt N-1's source).

1. **`effect-idioms`** (`idiomGate.ts`) — rules as data (`RuleConfig`:
   per-rule severity + include/exclude globs) over a PLUGGED registry (see
   "Plugging rules" below — the platform ships no implicit builtins). The
   shipped library is organized as packs: the `effect` pack
   (`effect/no-try-catch` — banTryCatch generalized, `effect/no-let`,
   `effect/no-nullable-return` — **type-aware**: the checker reads declared
   AND inferred return types, which is why the engine is compiler-API, not
   pattern-matching — `effect/match-over-tag-switch` (switch on `._tag` +
   else-if ladders; single guards are fine), `effect/no-as-any` (incl.
   `as unknown as T` laundering), `effect/branded-id-fields`,
   `effect/no-parallel-interface`) and the paradigm-neutral `quality` pack
   (`quality/no-skipped-tests` — a skipped test is the coder gaming the
   test gate; `quality/no-empty-catch`).
2. **`boundaries`** — each layer declares `canImport` (internal, by name)
   and `externals` (by prefix); everything else is a finding. Foundry's own
   6-layer config is the dogfood; pointing globs at package dirs makes the
   monorepo's `cli → adapters → core` rule a real gate.
3. **`typecheck`** — `ts.getPreEmitDiagnostics` on the shared program (no
   subprocess, exact positions) → `ts/<code>` findings.
4. **`eval-shape`** — `evals/nonempty-scorers` (the silent-0 hole),
   `evals/explicit-threshold` (the decorative-threshold hole),
   `evals/registered` (a suite not imported by the registry silently never
   runs).

## The loop — `forge`

`Effect.iterate` over an immutable `LoopState` — zero `let`, zero `while`:
implement (with `Schedule.exponential` retry on transient implementor
failures) → snapshot → `runPipeline` → `Match` the phase → accept, or feed
`renderFeedback` back and go again. Bounded by `maxAttempts` and a
wall-clock budget checked at attempt boundaries (a soft deadline — the first
attempt always completes; nothing is interrupted mid-work). **A rejected run
is a result, not an error**: the error channel carries only infrastructure
failures. Every run persists as a Schema-encoded JSON artifact via `RunSink`
(`.foundry/runs/<id>.json`), and every gate/attempt/run is spanned
(trace-first).

Implementors are adapters behind one port: `makeScriptedImplementor` (tests
and the key-free CI demo), `ClaudeCliImplementorLive` (`claude -p` in the
workspace — the runtime's Verifier precedent). The efferent agent itself
becomes an implementor in the runtime-integration phase.

## Plugging rules (per-project quality bars)

The rule registry is what the CONFIG MODULE provides — `gatesFromConfig`
never falls back to a builtin set. A `foundry.config.ts` has two channels:

- **Data** (the default export, Schema-decoded): which rules run where —
  `rules: [{ rule: "<ns>/<name>", include, exclude, severity? }]`,
  boundaries layers, the tsconfig.
- **Code** (named exports): `rulePacks` (imported from the shipped library
  inside this monorepo — `import { effectPack } from
  "@xandreed/foundry/gates/rules/packs.js"`) and/or `customRules` — plain
  structural rule objects:

  ```ts
  export const customRules = [{
    id: "local/no-default-export",        // "local/" is the convention
    defaultSeverity: "error",
    description: "default exports are banned",
    fixHint: "use a named export",
    check: ({ sourceFile, checker }) => [ /* {node, message} per violation */ ],
  }]
  ```

  The data half is Schema-decoded on OUR side (`RuleId.make` happens in the
  decoder — external workspaces never import foundry); the `check` function
  is wrapped FAIL-CLOSED: a crashing rule (or one returning a non-array)
  reports itself as a finding on the file it was checking, never a silent
  pass. Duplicate ids across packs+custom are a `ConfigError`.

- **Vendoring** (external workspaces — foundry is private, source-run):
  `vendoredPackFiles("<pack>")` emits the pack re-authored as plain TS
  files importing only the workspace's own `typescript`; the profile
  session writes them under `<ws>/.efferent/gates/` and the config plugs
  them in via `customRules`. Project-owned, human-editable; a golden test
  pins vendored ≡ library findings, so drift fails CI.

## The ratchet (adopting foundry on pre-existing code)

`foundry check --baseline <f.json>`: findings whose fingerprint —
`fnv1a(rule + file + normalized line CONTENT)`, so unrelated edits don't
churn — is in the committed baseline are grandfathered; any NEW fingerprint
fails; `--update-baseline` rewrites (and in CI may only shrink). This is how
sdk-core migrates incrementally instead of big-bang.

## Dogfooding + CI

- `foundry.config.ts` targets foundry's own `src/`; **`bun run foundry
  check` is clean in CI, always** — the mechanical proof of "exemplary
  Effect style".
- `bun run foundry demo` is the key-free E2E: the scripted implementor fails
  the idiom stage on attempt 1, typecheck on attempt 2, lands on attempt 3 —
  one rejection per rank, each with its feedback brief.

## Roadmap

- ~~Skeleton~~ — SHIPPED.
- ~~Rule expansion + monorepo gates~~ — SHIPPED: `effect/no-loop-statements`
  + `effect/no-parallel-interface`; `foundry.repo.config.ts` runs inside
  `bun run typecheck` (dependency direction is a gate; `banTryCatch.ts`
  retired — `effect/no-try-catch` is its generalization, still
  zero-tolerance on sdk-core).
- ~~Ratchet baselines~~ — SHIPPED: `packages/foundry/baselines/repo.json`
  (815 grandfathered fingerprints over the five legacy packages; any NEW
  finding fails). The gate's first catches, kept as debt to burn down:
  `sdk-core/usecases/schedule.ts` imports `node:os` (the documented rule is
  node:path only) and `evals/support/coder.ts` imports seven `efferent/*`
  (cli) modules against the package's own rule.
- ~~Evals v2 (structure)~~ — SHIPPED: `EvalSpec.scorers` is non-empty BY
  TYPE, `threshold` is required and honored per-suite by `run.ts`'s gate
  (the hardcoded 0.6 is gone); the eval-shape gate polices
  `packages/evals` in the repo suite. Still open from the v2 contract:
  trajectory-typed scorers (`ScorerArgsV2.trajectory`) and the branded
  `Score` in the runner.
- ~~Runtime integration (first seam)~~ — SHIPPED: `makeJudgeGate` (rank-4,
  non-deterministic, zero-reason rejections still fail) +
  `makeVerifierJudgeGate` (`packages/cli/src/foundry/`) wrapping the
  independent Opus `Verifier.gate` into a forge pipeline, fail-closed.
- ~~The agent in the factory~~ — SHIPPED as **`packages/smith`**
  (`@xandreed/smith`): `EfferentImplementorLive` runs the REAL efferent coder
  as the `Implementor` (one persisted conversation per forge run; retries
  continue it with the gate brief; `receipt.ref` links artifact ↔
  conversation), driven by `forge` with the new `ForgeHooks` progress seam,
  a smith-local rank-2 command/test gate, gate-suite discovery
  (`foundry.config.ts` / tsconfig / package.json), a headless `-p` mode and a
  Solid+OpenTUI factory-floor TUI. Deliberately a SEPARATE source-run package
  (never imported by `packages/cli` — foundry's `typescript` dependency must
  not enter the published bundle), so there is no `efferent forge` subcommand;
  the entry is `bun run smith`.
  Still open: `driveLoop` consuming a full foundry pipeline as the runtime's
  own deliverable gate.
- Later: mutation-testing gate
  (StrykerJS incremental — the anti-"tests that assert nothing" meta-gate),
  fast-check property gate, judge calibration before any judge gate blocks;
  promoting smith's command/test gate into foundry's built-ins.
