# Contributing to efferent

This repository holds the framework only: the coding CLI and the reference
applications moved to their own repositories on 2026-10-28. The rules for
the code are in the root [`AGENTS.md`](AGENTS.md); this file is the process
around them.

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.3 (CI pins 1.3.0) and Node ≥ 24.5 on
Linux: `verify:packages` runs the packed packages on Node, and
`@xandreed/plugin-models` declares 24.5. Development runs TypeScript
directly; distribution builds emit JavaScript and declarations.

```bash
git clone https://github.com/xandreeddev/efferent && cd efferent
bun install
```

`bun install` also installs a git pre-commit hook (`scripts/installHooks.ts`,
in a standard checkout) that runs the repo gate profile before each commit.
Keep it; never commit with `--no-verify`.

The tests expect no proxy in the environment: Bun's fetch sends even the
loopback servers they start to `HTTP_PROXY` / `HTTPS_PROXY`, so run them with
those unset (the proxy tests that would go direct skip when one is set).

## The gates are the review

The definition of done is the root `AGENTS.md` "Definition of done": the
commands `.github/workflows/ci.yml` runs, in order. Its "Gate rules" table
lists every rule `bun run typecheck` applies (the repo profile over every
package, foundry's source included, then tsc over `scripts/`), and
`bun run foundry check` runs foundry's own layer profile. A test
(`scripts/agents-guide.test.ts`) keeps that table and that list in step
with `foundry.config.ts` and `ci.yml`.

The committed baseline (`.foundry/baseline.json`) stays empty, and
`bun run typecheck` fails while it holds a fingerprint
(`quality/baseline-empty`): the repo profile grandfathers nothing. Fix a
finding instead of passing `--update-baseline --allow-grow`; that flag
warns that CI will refuse the grown file.

## Adding a package or a plugin

Follow the `add-plugin` skill (`.agents/skills/add-plugin/SKILL.md`). A new
package under `packages/` must be registered by hand, and
`bun run typecheck` fails (`quality/package-registered`) naming each list
it is missing from:

- `CHECKED` in `foundry.config.ts` (`"packages/<name>/src/**"`), so the
  rules check its sources;
- a `boundaries.layers` entry in `foundry.config.ts`, so its imports are
  checked (add a `<name>-tests` layer before it if its tests import more);
- `names` in `scripts/build-packages.ts`, so it is built, verified and
  published (foundry, development tooling, is exempt);
- `compilerOptions.paths` in `tsconfig.base.json` (`"@xandreed/<name>"`);
- for a `plugin-*` package, `firstParty` in
  `scripts/generate-plugin-reference.ts` (import the package and list its
  plugins; `bun run docs:generate` also fails on an exported plugin missing
  there).

The lists the check reads are the `registration` data in
`foundry.config.ts`; the docs site (`packages/website`) is exempt.

## PRs

- Branch off `main`; PRs squash-merge, so the PR title becomes the commit
  title and the body its message: write both as the `commit-style` skill
  says.
- Keep a PR to one concern; tests ride the same PR as the change.
- New agent behavior ships with its evaluation — a calibration or a journey
  (`docs/composable-evaluations.md`); the battery is part of the definition of done.
- Colocate tests next to the source (`foo.ts` / `foo.test.ts`); fixtures live
  outside `src/` so the gates never see deliberate violations.
- A change to a documented contract updates `docs/framework.md` and the
  matching page under `packages/website/src/content/docs/concepts/` in the
  same PR. Their `@xandreed/*` imports in code blocks are compiled against
  the packed packages (`verify:packages`); generated pages are never edited
  by hand.
- Run `bun run docs:generate` after a change to an event, a stored payload,
  or a plugin's id, version, scope, configuration schema, defaults,
  `requires`, `optional`, `provides` or `contributes`. It writes the
  [plugin](docs/plugin-reference.json) and [event](docs/event-reference.md)
  references, the guides' snippets and their website pages; CI fails on any
  difference from what is committed.
- What each published entry exports is recorded in `api/`: one file per
  entry, `api/<package>.api.txt` for a package's root and
  `api/<package>--<subpath>.api.txt` for each other entry (every `/` of the
  subpath a `--`), each the sorted `kind name` lines of its exports, read
  from the build's declarations (`scripts/api-snapshot.ts`). After a change
  that adds, removes or renames an export, or turns a value export into a
  type-only one, run `bun run api:update` (it runs `build:packages`, then
  rewrites `api/`) and commit the diff; `verify:packages` fails while `api/`
  differs from the build. A package's root entry may not export a name
  declared in a package's `src/internal/` or `src/engine/` folder: those
  modules are published through entries of their own, outside semver.
- Every release's journal fixture stays readable
  (`packages/sdk/src/journal-compat.test.ts` reads each
  `packages/sdk/fixtures/journal-<version>.json`). A fixture records what a
  release wrote: record one per release with
  `bun scripts/record-journal-fixture.ts`. It refuses to overwrite an
  existing fixture unless `--force` is passed, and `--force` is only for
  re-recording the current, unreleased version. Evaluation reports follow
  the same rule: `packages/evals/src/run-compat.test.ts` reads each
  `packages/evals/fixtures/run-<version>.json`, recorded with
  `bun scripts/record-run-fixture.ts`.
- The sdk golden (`packages/sdk/src/agent.golden.test.ts`) pins one
  conversation byte for byte: what the model and the host see
  (`packages/sdk/golden/agent-turn.model.json`) and what the session stores
  (`agent-turn.journal.json`). After a deliberate change, re-record with
  `EFFERENT_UPDATE_MODEL_GOLDEN=1` (model text) or `EFFERENT_UPDATE_GOLDEN=1`
  (storage format) on `bun test packages/sdk/src/agent.golden.test.ts`, read
  the whole `git diff` of the golden, and explain each change in the PR.
  Never re-record to silence a failure you cannot explain.
- A guide's code is not edited in the guide: `docs/events.md` quotes the
  regions of `packages/sdk/src/events-guide.test.ts`, a test that runs, and
  `bun run docs:generate` (`scripts/sync-guides.ts`) copies them in with the
  imports they use and writes the guide's website page. It fails on a
  snippet that imports from a relative path, the test runner (`bun:`) or
  test scaffolding (a `testing` module), a region no guide quotes, a
  snippet marker not followed by a `ts` fence, a TypeScript or JavaScript
  fence that is neither a snippet nor marked `<!-- unchecked: why -->`, and
  a link to a missing file or heading.
- Add an entry under **Unreleased** in `CHANGELOG.md`: what changes for
  someone using the packages. Use its headings: `### Migration` (what a
  user must do), `### Breaking`, `### Added`, `### Fixed` and
  `### Repository` (changes to this repository only). Start a package's
  entry with its name (`` `@xandreed/plugin-render`: ``).

## Publishing

The framework packages are published from a maintainer's terminal; there is
no release automation, and publishing needs explicit sign-off. All 19
publishable packages (`names` in `scripts/build-packages.ts`) share one version (`0.14.0` in the sources) and are
published under npm's `latest` tag. The build writes `private: false` into
each manifest it builds, so a source `private: true` (core's) does not keep
a package off npm. The previously published `efferent`,
`@xandreed/cli` and `@xandreed/sdk-*` packages are a frozen earlier line.

For a release, set the new version in every publishable `package.json` and in
each plugin definition (`version:` in `definePlugin`), run
`bun run docs:generate`, and turn the changelog's **Unreleased** section into
the new version, with the release date. Set the version in the README's,
the website getting-started page's and the website home page's "published
at" sentences, and drop any README exception for a package not yet on npm
(npm holds older `@xandreed/plugin-telemetry` versions, 0.3.0 and 0.4.0, from
an earlier line: check with `npm view @xandreed/plugin-telemetry versions`
that none is at or above the new version). Record the release's journal
fixture with `bun scripts/record-journal-fixture.ts` and its evaluation run
with `bun scripts/record-run-fixture.ts`. Merge that, then
publish from a clean checkout of the merge commit:

```sh
bun install --frozen-lockfile
bun run build:packages            # also writes .artifacts/packages/build.json
bun run verify:packages
bun run publish:packages          # dry run: every check, then npm publish --dry-run
bun run publish:packages --publish
```

The distribution build resolves `workspace:*` dependencies to caret ranges of
the matching package versions (`^0.14.0`) and declares `@xandreed/core` and
`effect` peer dependencies at caret ranges (`^0.14.0`, `^4.0.7`), never exact
pins, so a host on other patch versions installs one copy of `@xandreed/core`
and of `effect`, and one whose dependencies cannot share a copy gets a peer
conflict instead of a second one (`scripts/distribution-manifest.ts`). It
stamps `build.json` with the commit, whether the working tree had changes, the
shared version and the packages it built. Changes are tracked and untracked
files anywhere, plus gitignored files in a package's `src`, `skills` or
`profiles` folder, which the build copies too.
`publish:packages` refuses, before publishing anything, when:

- the packages do not all share one version;
- a built version differs from its source `package.json`;
- `build.json` is missing, does not list the built packages, records a commit
  other than `HEAD`, or records a build from a tree with changes;
- the working tree has changes, untracked files included;
- the `@xandreed/*` dependencies between the packages form a cycle;
- `npm whoami` fails (log in with `npm login`), or names an account other than
  the project's (`xandreed`);
- the registry cannot be reached, or answers anything but found or not found,
  when asked whether a version is already published.

Every step uses `https://registry.npmjs.org`: the already-published check,
`npm whoami` and `npm publish`, which is passed the registry so that npm
settings (a scoped `@xandreed:registry` included) cannot send it elsewhere. It
publishes one package at a time, each after the `@xandreed/*` packages it
depends on, with `npm publish <dir> --access public --tag latest`. A
`name@version` already on the registry is skipped (the check bypasses the
registry's cache), so a run that stopped part-way can be repeated. npm runs in
the same terminal, so its two-factor prompt works there; run it from an
interactive terminal. Merging a version bump publishes nothing; tag the
release (`v<version>`) after it is on npm. Tags resume with `v0.14.0`; 0.11.0
to 0.13.0 have none (`v0.1.1` to `v0.3.0` belong to the frozen earlier line).

Never publish from a commit whose version is already on npm for some
packages, unless it is the commit those were published from (a run that
stopped part-way). The skip above would then publish only what is missing,
such as a package added since that release, depending on the published
`@xandreed/*` versions, which lack what it needs. A new package starts at
the current shared version and first ships with the next version bump.

Pushing a `v<version>` tag also deploys the documentation site from that tag
(`.github/workflows/docs.yml`; a manual dispatch can deploy it too), so push
the tag only with the same sign-off as the npm publish. The `github-pages`
environment must allow `v*` tags to deploy: it allowed only `main` before the
site moved to tag deploys, and a refused tag fails the deploy job after the
build. Add the rule once, in Settings → Environments → github-pages →
Deployment branches and tags, or with
`gh api -X POST repos/xandreeddev/efferent/environments/github-pages/deployment-branch-policies -f name='v*' -f type=tag`.

## Distribution changes

Run `bun run build:packages` and then `bun run verify:packages` for package
changes. `verify:packages` checks only the build of `HEAD` (`build.json`)
from a clean tree, and refuses test code in it (`*.test.*`, `testing`
modules and folders, which the build leaves out); to check a build of
uncommitted changes, run `bun run verify:packages --allow-dirty` right after
`bun run build:packages`. It then compares each published entry's exports
with `api/` and names every line that differs (`bun run api:update` rewrites
it), and checks the consumer installed exactly one copy of `@xandreed/core`
and of `effect`. The external-consumer test installs local tarballs; it
never publishes them.
