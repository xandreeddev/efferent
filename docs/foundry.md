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
   per-rule severity + include/exclude globs). Built-ins:
   `effect/no-try-catch` (banTryCatch generalized), `effect/no-let`,
   `effect/no-nullable-return` (**type-aware** — the checker reads declared
   AND inferred return types; this is why the engine is compiler-API, not
   pattern-matching), `effect/match-over-tag-switch` (switch on `._tag` +
   else-if ladders; single guards are fine), `effect/no-as-any` (incl.
   `as unknown as T` laundering), `effect/branded-id-fields` (the branding
   rubric's first enforced slice).
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

- ~~Skeleton (this doc)~~ — SHIPPED.
- **Rule expansion + monorepo gates**: `effect/no-loop-statements`,
  `effect/no-parallel-interface`; a repo-level boundaries config
  (`cli → adapters → core` as a gate); fold `foundry check` into
  `bun run typecheck`; retire `scripts/banTryCatch.ts`.
- **Ratchet baselines** for sdk-core/adapters/cli.
- **Evals v2**: `packages/evals` migrates onto `EvalContract` (non-empty
  scorers, required branded threshold honored by the runner — replacing the
  hardcoded 0.6 — trajectory scorers); the eval-shape gate goes
  error-severity on `packages/evals`.
- **Runtime integration**: the efferent agent as an `Implementor`;
  `driveLoop` consuming a foundry pipeline with the existing `Verifier`
  wrapped as the rank-4 judge gate; `efferent forge` CLI.
- Later: a `test` gate (bun test in-workspace), mutation-testing gate
  (StrykerJS incremental — the anti-"tests that assert nothing" meta-gate),
  fast-check property gate, judge calibration before any judge gate blocks.
