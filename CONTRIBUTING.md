# Contributing to efferent

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.3 on Linux. Development runs TypeScript directly; distribution builds
emit JavaScript and declarations.

```bash
git clone https://github.com/xandreeddev/efferent && cd efferent
bun install
```

## The gates are the review

Every change must leave all of these green — CI enforces them, and the repo runs
its **own** static gates on its own source at a **zero baseline** (one new
violation anywhere fails the build):

```bash
bun run typecheck     # tsc + foundry self-check + the zero-baseline repo gate suite
bun test              # colocated unit tests — key-free by design
bun run foundry demo  # the forge-loop E2E over a scripted implementor
```

House rules the gates enforce (see the root `AGENTS.md` for the full list):
errors are `Schema.TaggedError` values (no `try`/`catch`/`throw`), state is a
fold (no `let`, no loop statements), absence is `Option`, union branching is
`Match`, dependency direction between packages is a build-failing gate.

## PRs

- Branch off `main`; PRs squash-merge.
- Keep a PR to one concern; tests ride the same PR as the change.
- New agent behavior ships with its evaluation — a calibration or a journey
  (`docs/composable-evaluations.md`); the battery is part of the definition of done.
- Colocate tests next to the source (`foo.ts` / `foo.test.ts`); fixtures live
  outside `src/` so the gates never see deliberate violations.

## Publishing

The framework packages are published manually; there is no release
automation. All 18 publishable packages share one version (currently `0.11.0`)
under npm's `latest` tag. The previously published `efferent`, `@xandreed/cli`
and `@xandreed/sdk-*` packages are a frozen earlier line.

For a release, set the new version in every publishable `package.json` and in
each plugin definition (`version:` in `definePlugin`), then run
`bun run docs:generate`. The distribution build resolves `workspace:*`
dependencies to the matching package versions. Build and verify:

```sh
bun run build:packages
bun run verify:packages
```

Publish in dependency order, skipping any version already on npm: `core`; the
plugins; `runtime`; `sdk` (after `runtime`, `plugin-memory` and
`plugin-session-sqlite`); then `evals`, `evals-cli`, `evals-langfuse` and
`evals-langsmith`:

```sh
npm publish ./.artifacts/packages/<package> --access public --tag latest
```

These commands are manual; merging a version bump publishes nothing.

## Distribution changes

Run `bun run build:packages` and `bun run verify:packages` for package changes.
The external-consumer test installs local tarballs; it never publishes them.
Run `bun run --cwd packages/website check` for documentation changes.
