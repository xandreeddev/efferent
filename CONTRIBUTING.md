# Contributing to efferent

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.3 on Linux. Development runs TypeScript directly; distribution builds
emit JavaScript and declarations.

```bash
git clone https://github.com/xandreeddev/efferent && cd efferent
bun install
```

## The gates are the review

Every change must leave all three green — CI enforces them, and the repo runs
its **own** static gates on its own source at a **zero baseline** (one new
violation anywhere fails the build):

```bash
bun run typecheck     # tsc + foundry self-check + the zero-baseline repo gate suite
bun test              # colocated unit tests — key-free by design
bun run scenarios     # scenario packs vs committed baselines (scripted twins)
```

House rules the gates enforce (see the root `AGENTS.md` for the full list):
errors are `Schema.TaggedError` values (no `try`/`catch`/`throw`), state is a
fold (no `let`, no loop statements), absence is `Option`, union branching is
`Match`, dependency direction between packages is a build-failing gate.

## PRs

- Branch off `main`; PRs squash-merge.
- Keep a PR to one concern; tests ride the same PR as the change.
- New agent behavior ships with its scenario-pack additions — the battery is
  part of the definition of done.
- Colocate tests next to the source (`foo.ts` / `foo.test.ts`); fixtures live
  outside `src/` so the gates never see deliberate violations.

## Publishing status

The previously published npm packages (`efferent`, `@xandreed/cli`, and the
`@xandreed/sdk-*` line) are the **frozen previous line** — they receive no
further releases, and the release automation has been removed from this repo.
The current CLI is source-run only. `@xandreed/core`, `@xandreed/evals`,
`@xandreed/runtime`, `@xandreed/sdk`, and all nine `@xandreed/plugin-*`
packages are published manually at `0.3.0` under npm's `latest` tag.
Release automation has not been reintroduced.

For a manual evals release, bump `packages/evals/package.json` and its
`@xandreed/core` dependency's manifest when that dependency needs a release.
The distribution build preserves those versions and resolves `workspace:*`
dependencies to the corresponding package versions. Build and verify, then
publish the dependency before evals:

```sh
bun run build:packages
bun run verify:packages
npm publish ./.artifacts/packages/core --access public --tag latest
npm publish ./.artifacts/packages/evals --access public --tag latest
```

Publish only versions that are not already on npm. These commands are manual;
merging a version bump does not publish anything automatically.

For plugin releases, also update the version in each plugin definition and
run `bun run docs:generate`. Publish core before the plugins and runtime;
publish the SDK after runtime, plugin-memory, and plugin-session-sqlite are
available. For example, after building and verifying, a full plugin release
uses this dependency order (skip any version already published):

```sh
for package in plugin-agent-loop plugin-context plugin-mcp plugin-memory \
  plugin-models plugin-policy-workspace plugin-session-sqlite \
  plugin-telemetry plugin-tools-local runtime sdk; do
  npm publish "./.artifacts/packages/$package" --access public --tag latest || exit
done
```

## Distribution and terminal changes

Run `bun run build:packages` and `bun run verify:packages` for package changes.
Run `python scripts/verify-tui.py` and the TUI frame tests for terminal changes.
The external-consumer test installs local tarballs; it never publishes them.
Run `bun run --cwd packages/website check` for documentation changes.
