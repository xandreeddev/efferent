# @xandreed/foundry

The factory: a verification loop + gate pipeline. `forge(spec)` drives spec →
implement (via the `Implementor` port) → deterministic gate pipeline → typed
feedback → retry until sound. See `docs/foundry.md` for the full design.
`ForgeOptions.hooks` (`ForgeHooks` — onAttemptStart / onImplemented / onReport /
onOutcome, observe-only `Effect<void>`) is the driver-UI progress seam, and an
implementor's `receipt.ref` (opaque provenance, e.g. `conversation:<uuid>`)
threads into `AttemptRecord.implementorRef` so the persisted artifact links
back to the implementor's own record. `AttemptRecord.filesTouched` is
OBSERVED, not claimed: `ForgeOptions.fingerprint` (the movement oracle —
`fingerprintWorkspace` in production) runs before and after each implement
call, and the diff ∪ receipt claim is what gets recorded and what the
stalled breaker keys on (Bash-heredoc writes are invisible to tool-call
capture — the zig re-forge recorded "0 files" while main.zig was being
rewritten via `cat >`). The reference consumer is `@xandreed/smith` — the
efferent coder standing at this forge.

**This package is written in the style its own gates enforce, and CI runs
`bun run foundry check` on this source (`foundry.config.ts`) — a violation
here fails the build.** Runtime deps: `effect` + `typescript` only. Never
import `@xandreed/sdk-core`/adapters/cli — the runtime consumes foundry,
never the reverse.

**Rules are PLUG-INS, never builtins**: the idiom-rule registry is what the
config module itself exports (`rulePacks` — the shipped library packs
`effect`/`quality` from `gates/rules/packs.js` — and/or `customRules`,
plain structural objects decoded fail-closed in `gates/rules/custom.js`);
`gatesFromConfig(config, registry)` resolves `rules` entries against THAT.
External workspaces get packs VENDORED as plain TS
(`vendoredPackFiles`, sources under `vendor/<pack>/`) — a golden test in
`cli/check.test.ts` pins vendored ≡ library findings. The platform ships
engines, the config brings the opinions; even efferent's own two configs
import the effect pack explicitly.

## Layering (enforced by the boundaries gate — see foundry.config.ts)

```
src/
├── domain/    entities, brands, errors — imports effect ONLY
├── ports/     Gate (a value contract) + Implementor/RunSink (Context.Tag)
├── pipeline/  runPipeline · renderFeedback · forge · baseline — pure use cases
├── gates/     the static-analysis adapters over ONE shared ts.Program
├── adapters/  fs/subprocess adapters (scripted + claude implementors, run sink)
├── cli/       check · demo · report — presentation
├── index.ts   public surface        main.ts   the driver edge
```

## House policies (the gates enforce the enforceable parts)

- **Option, not nullable**: functions never return `A | undefined` / `A | null`
  (`effect/no-nullable-return`); entities express absence with
  `Schema.optionalWith(S, { as: "Option" })` — Option in memory, plain
  optional field on the wire. `undefined` only at optional parameters, TS
  compiler-API interop inside `src/gates/**`, and argv parsing.
- **Match, not tag switches**: union branching via `Match.value(...).pipe(
  Match.tag(...), Match.exhaustive)` or `Option.match`/`Either.match`
  (`effect/match-over-tag-switch`). A single `_tag` guard is fine.
- **No `let`/`var`** (`effect/no-let`): state is an immutable fold —
  `Effect.iterate` (the forge loop), `Effect.reduce` (the pipeline),
  `Array` combinators — or a `Ref`.
- **No try/catch/throw/.catch()** (`effect/no-try-catch`): typed errors are
  `Schema.TaggedError` (they cross serialization boundaries — the FactoryRun
  artifact); wrap foreign promises with `Effect.tryPromise`.
- **Entities are `Schema.Class`** (the class IS the type + constructor +
  Equal/Hash — no parallel hand-written interfaces); id-shaped fields are
  branded (`effect/branded-id-fields`, rubric in
  `docs/branded-types-roadmap.md`).
- **Fail-closed everywhere**: a gate that cannot run is a `fail` verdict,
  never a silent pass; a rejected forge run is a RESULT (the report is the
  deliverable), not an error.

## Commands

```bash
bun run foundry check                      # self-check (the dogfood; CI-enforced)
bun run foundry check --config <f> [--baseline <f.json>] [--update-baseline]
bun run foundry demo                       # key-free E2E: scripted implementor, 3 attempts
bun run foundry demo --implementor claude  # same spec, real agent
bun test packages/foundry                  # colocated unit tests (no LLM, no network)
```

Fixtures live OUTSIDE `src/` (`fixtures/`) so the root typecheck and the
self-check never see their deliberate violations.
