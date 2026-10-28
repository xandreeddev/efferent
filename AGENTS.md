# Efferent — composable agent framework on Effect, for Node and Bun

Read `../CLAUDE.md` for identity and repository rules. The current architecture
and configuration contract are documented in `README.md` and `docs/framework.md`.

Shared development skills live in `.agents/skills/<name>/SKILL.md`.
`CLAUDE.md` links to `AGENTS.md`; `.claude/skills` links to `.agents/skills`.

## Architecture

- `core`: shared schemas, ports and protocol helpers; no provider or host imports.
- `runtime` → core: plugin dependency graph and scoped plugin activation.
- `sdk` → runtime/core: `Agent.define` and `Agent.turn`, the composable agent over sessions.
- `plugin-*` → core: independently configurable capabilities, including the agent loop.
- `evals` (+ `evals-cli`, `evals-langfuse`, `evals-langsmith`): tasks, trials, graders and suites; the local CLI and exporters run on Node 24.
- `foundry`: independent verification framework, no internal package dependencies; development tooling, not published.
- `website`: the docs site; not published.

This repository holds the framework only. The coding CLI (`cli`, `tui`,
`smith`), the reference applications and the plugins only they used were
removed on 2026-10-28 and are moving to their own repositories.
Everything except `plugin-session-sqlite` (`bun:sqlite`) must also load on
Node; `bun run verify:packages` imports every Node-capable package on Node.

All production packages participate in the zero-baseline architecture gates.
New session data uses `.efferent/runtime`; never delete old local data to reset it.
Build artifacts go under `.artifacts`. Publishing requires explicit sign-off;
releases go through `bun run publish:packages`, a dry run unless
`--publish` (CONTRIBUTING.md, "Publishing"). Every PR adds an entry under
"Unreleased" in `CHANGELOG.md`. An event or stored-payload change regenerates
the references (`bun run docs:generate`, which writes `docs/event-reference.*`)
and must keep `packages/sdk/fixtures/journal-0.13.0.json` decoding.

## Conventions (gate-enforced, ZERO baseline)

`bun run typecheck` = the canonical repo profile (static architecture + tsc),
then tsc over `scripts/` (`scripts/tsconfig.json`), and the committed baseline
is EMPTY — every rule violation anywhere fails:

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
- Ports are `Context.Service` services in core or domain packages; adapters are
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
  `bun test`, `bun run foundry demo` (the forge-loop E2E), and the packed
  consumer check (`bun run verify:packages`).

## Running and validating

JSON and TypeScript configuration resolve through the same plugin graph.

Run `bun run typecheck`, `bun test`, `bun run foundry demo`,
`bun run build:packages`, `bun run verify:packages`, and the website check.
A passing fixture smoke test does not establish that model setup or real
provider calls work.
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
