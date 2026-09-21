# Efferent — composable agent SDK on Effect + Bun

Read `../CLAUDE.md` for identity and repository rules. The current architecture
and configuration contract are documented in `README.md` and `docs/framework.md`.

## Architecture

- `core`: shared schemas, ports and protocol helpers; no provider or host imports.
- `runtime` → core: configuration, dependency graph and scoped plugin activation.
- `sdk` → runtime/core: sessions, replay, queues, cancellation and safe reconfiguration.
- `plugin-*` → core: independently configurable capabilities, including the agent loop.
- `smith`: coding preset and optional spec/forge workflows.
- `tui` → SDK/core: reusable terminal presentation. It must not import Smith.
- `cli`: composition and user commands.
- `evals`: reusable runner; `scenarios`: reference-application packs and baselines.
- `foundry`: independent verification framework, no internal package dependencies.
- Canvas, Math, Social and the structured UI-agent remain reference applications.

All production packages participate in the zero-baseline architecture gates.
New session data uses `.efferent/runtime`; never delete old local data to reset it.
Build artifacts go under `.artifacts`. Publishing requires explicit sign-off.

## Conventions (gate-enforced, ZERO baseline)

`bun run typecheck` = the canonical repo profile (static architecture + tsc), and
the committed baseline is EMPTY — every rule violation anywhere fails:

- **Errors are values**: no `try`/`catch`/`throw`/`.catch()` — typed errors
  are `Schema.TaggedError`; foreign promises via `Effect.tryPromise` (or the
  two-arg `.then` for pure-promise fallbacks).
- **State is a fold**: no `let`, no loop statements — `Effect.iterate` /
  `Effect.reduce` / array combinators / `Ref`.
- **Absence is `Option`** (never `A | undefined` returns); union branching is
  `Match`; no `as any` / `as unknown as` laundering; entities are
  `Schema.Class`/`Struct` with branded id fields; no parallel interfaces.
- Tool failures are DATA: toolkits use the shared `Failure` struct with
  `failureMode: "return"` so the model corrects in the same run.
- Ports are `Context.Tag` services in core or domain packages; adapters are
  `<Thing>Live` Layers in capability plugins; composition happens at each agent's
  `main.ts` edge and nowhere else.
- New domain/application features use qualified pairs: `thing.entity.ts` +
  `thing.entity.functions.ts`, and `do-thing.usecase.ts` +
  `do-thing.usecase.functions.ts`. Entity/use-case contracts contain Schema
  definitions and derived types; behavior lives in the paired functions file.
  Ports end in `.port.ts`; adapters end in `.adapter.ts` and may bridge foreign
  promises only through `Effect.tryPromise`. Raw Promise orchestration,
  runtime imports, `Effect.run*`, and Layer construction never enter the core.
- **After any task, run `bun run typecheck`** — a banned construct or a fresh
  finding fails the command and the change is rejected. CI additionally runs
  `bun test`, `bun run foundry demo` (the forge-loop E2E), and
  `bun run scenarios` (the scripted packs vs committed baselines).

## Running and validating

Use `bun run efferent` (or `bun run smith`) for direct coding. `/spec`, `/lock`
and `/forge` activate the configurable workflow plugin. The historical
spec/forge driver is `bun run smith:workflow`. JSON and TypeScript configuration
resolve through the same plugin graph. UI changes belong in JSON overrides.

Run `bun run typecheck`, `bun test`, `bun run foundry demo`, `bun run scenarios`,
`bun run build:packages`, `bun run verify:packages`, and the website check.
For terminal changes run `python scripts/verify-tmux.py` against the actual CLI,
`python scripts/verify-tui.py`, and the TUI frame tests. A passing fixture smoke
test does not establish that model setup, commands, or real provider calls work.
Provider-backed evals require explicit model/credential configuration; preserve
candidate, prompt, schema and protocol versions in their evidence.

## OPSEC reminder

Keep the pseudonymous project identity separate from personal and client
identities. Never record downstream client names, private repository paths,
or identity correlations in this repository, its documentation, or artifacts.
Normal package attribution is permitted; it does not imply shared authorship.

Every commit under this tree must be authored as
`Xand Reed <xandreed@proton.me>` — verify with `git config user.email`. Never
reference the real name in any file, commit, comment, or screenshot. Never
add AI co-author trailers. Never commit anything from
`~/Workspace/xandreed/pi`. Cutting anything outward-facing (npm, the docs
site) happens only on explicit sign-off.
