# @xandreed/foundry

The factory: a verification loop + gate pipeline. `forge(spec)` drives spec →
implement (via the `Implementor` port) → deterministic gate pipeline → typed
feedback → retry until sound. `docs/foundry.md` has the design; its "Why"
and "Roadmap" sections describe the earlier line and are history.
`ForgeOptions.hooks` (`ForgeHooks` — onAttemptStart / onImplemented / onReport /
onOutcome, observe-only `Effect<void>`) is the driver-UI progress seam, and an
implementor's `receipt.ref` (opaque provenance, e.g. `conversation:<uuid>`)
threads into `AttemptRecord.implementorRef` so the persisted artifact links
back to the implementor's own record. `AttemptRecord.filesTouched` is
OBSERVED, not claimed: `ForgeOptions.fingerprint` (the movement oracle —
`fingerprintWorkspace` in production) runs before and after each implement
call, and the diff ∪ receipt claim is what gets recorded and what the
stalled breaker keys on (writes through `bash`, such as a heredoc or
`cat >`, are invisible to tool-call capture, so the fingerprint observes the
workspace itself). In this repository foundry runs the
architecture gates (`bun run typecheck`); its coding-agent consumer moved out
with the CLI.

**This package is written in the style its own gates enforce, and CI runs
`bun run foundry check` on this source (`foundry.config.ts`) — a violation
here fails the build.** Runtime deps: `effect` + `typescript` only. Never
import another `@xandreed/*` package: foundry's layer in the root
`foundry.config.ts` has `canImport: []`, and that config, not a framework
package, is what imports foundry.

**Rules are PLUG-INS, never builtins**: the idiom-rule registry is what the
config module itself exports (`rulePacks` — the shipped library packs
`effect`, `quality` and `effect-architecture` from `gates/rules/packs.js` —
and/or `customRules`, plain structural objects decoded fail-closed in
`gates/rules/custom.js`);
`gatesFromConfig(config, registry)` resolves `rules` entries against THAT.
External workspaces get packs VENDORED as plain TS
(`vendoredPackFiles`, sources under `vendor/<pack>/`) — a golden test in
`cli/check.test.ts` pins vendored ≡ library findings. The platform ships
engines, the config brings the opinions; even efferent's own two configs
name their packs explicitly (the root one all three, foundry's own `effect`).

## Layering (enforced by the boundaries gate — see foundry.config.ts)

```
src/
├── domain/    entities, brands, errors, the baseline (baseline.ts) — imports effect ONLY
├── ports/     Gate (a value contract) + Implementor/RunSink (Context.Service)
├── pipeline/  runPipeline · renderFeedback · forge · lessons — pure use cases
├── gates/     the gates over ONE shared ts.Program (typecheck, idiom, boundaries,
│              registration, judge), withBaseline, rules/; TsProject.port.ts is
│              the one port outside ports/
├── adapters/  fs/subprocess adapters (scripted + claude implementors, run sink)
├── cli/       check · demo · report — presentation
├── index.ts   public surface        main.ts   the driver edge
vendor/<pack>/ the packs as plain TS for external workspaces
```

## House policies (the gates enforce the enforceable parts)

- **Option, not nullable**: functions never return `A | undefined` / `A | null`
  (`effect/no-nullable-return`); in foundry, entities express absence with
  `Schema.OptionFromOptional(S)` — Option in memory, plain
  optional field on the wire. `undefined` only at optional parameters, TS
  compiler-API interop inside `src/gates/**`, and argv parsing.
- **Match, not tag switches**: union branching via `Match.value(...).pipe(
  Match.tag(...), Match.exhaustive)` or `Option.match`/`Result.match`
  (`effect/match-over-tag-switch`). A single `_tag` guard is fine.
- **No `let`/`var`** (`effect/no-let`): state is an immutable fold — a
  recursive Effect step (the forge loop's `iterate`), `Effect.reduce` (the
  pipeline), `Array` combinators — or a `Ref`. (`Effect.iterate` does not
  exist in Effect 4.)
- **No try/catch/throw/.catch()** (`effect/no-try-catch`): typed errors are
  `Schema.TaggedError` (they cross serialization boundaries — the FactoryRun
  artifact); wrap foreign promises with `Effect.tryPromise`.
- **Entities are `Schema.Class`** (the class IS the type + constructor +
  Equal/Hash — no parallel hand-written interfaces); id-shaped fields are
  branded (`effect/branded-id-fields`).
- **Fail-closed everywhere**: a gate that cannot run is a `fail` verdict,
  never a silent pass; a rejected forge run is a RESULT (the report is the
  deliverable), not an error.

## Commands

```bash
bun run foundry check                      # self-check (the dogfood; CI-enforced)
bun run foundry check --config <f> [--baseline <f.json>] [--update-baseline [--allow-grow]]
bun run foundry demo                       # key-free E2E: scripted implementor, 3 attempts
bun run foundry demo --implementor claude  # same spec, real agent
bun test packages/foundry                  # colocated unit tests (no LLM, no network)
```

`--update-baseline` only shrinks the baseline. `--allow-grow` grandfathers
new findings and prints a warning: a profile with `baseline: "empty"` (the
repo profile, so `bun run typecheck` and CI) grandfathers nothing and fails
with `quality/baseline-empty` while the file holds a fingerprint. Never use
either flag against this repository's `.foundry/baseline.json`: fix the
finding, or, where type erasure is the design, add the file to
`ERASURE_BOUNDARY` in the root `foundry.config.ts` with the reason in the PR.

A config's `registration` arms the `registration` gate
(`gates/registrationGate.ts`, findings `quality/package-registered`): every
package under its `roots` must be covered by the profile's rules and
boundaries layers and listed in each file registry it names (a top-level
`const` array in a TypeScript file, or the keys of a JSON object). The repo
knowledge (which lists, which packages are exempt) is data in the root
`foundry.config.ts`; the gate imports no workspace package.

A config's `privateText` arms the `private-text` gate
(`gates/privateTextGate.ts`, findings `quality/no-private-text`): no file
git tracks or would track may hold an absolute home path (other than a
configured placeholder home) or a term of the config's local, git-ignored
denylist. Its messages never repeat what matched. A rule entry's `boundary`
globs drop the matches the rule marks `toleratedAtBoundary`:
`effect/no-as-never`'s plain `as never` (where type erasure is the
design), and `effect/match-over-tag-switch`'s ternary chains and
`type`/`role`/`mode` discriminants (in the packages not yet converted;
its `switch` and ladder on `_tag` report everywhere). A rule entry's
`allow` names exact files the rule skips, a frozen list that only
shrinks: an entry naming a file the rule does not check, or one it no
longer flags, is itself a finding under the rule's id
(`architecture/role-suffix-required`'s `ROLELESS_FILES`,
`effect/no-option-unwrap`'s `NULLABLE_EDGES`). A new rule that needs a
per-file exemption uses `exclude`, `allow` for today's exceptions, or a
boundary when only part of what it flags is the design there. A rule with
findings enters through its `include`, one clean package at a time (the
lists in the root `foundry.config.ts`), never through the baseline.

The `effect` pack's second wave: `effect/no-silent-ignore` (a dropped
failure is logged first: `Effect.ignore({ log })` or a logging
`tapError`/`tapCause` earlier in the pipe), `effect/no-option-unwrap`,
`effect/no-stringified-cause` (type-aware: a failure turned to text
inside a tagged error), `effect/no-error-code-compare` (type-aware: a
code compared outside the file declaring it and its `.functions.ts`),
`effect/prefer-effect-fn` and `effect/require-concurrency-option`
(type-aware about `forEach`'s data-last form); the `effect-architecture`
pack adds `architecture/role-suffix-required`.

Fixtures live OUTSIDE `src/` (`fixtures/`) so the root typecheck and the
self-check never see their deliberate violations.
