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
  checked, and a `<name>-tests` layer before it (`testLayer`) for its test
  code, the only layer that may import a test library;
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
  declared in a package's `src/internal/` folder: those modules are
  published through an entry of their own, outside semver.
- Every release's journal fixture stays readable
  (`packages/sdk/src/journal-compat.test.ts` reads each
  `packages/sdk/fixtures/journal-<version>.json`). A fixture records what a
  release wrote: record one per release with
  `bun scripts/record-journal-fixture.ts`. It refuses to overwrite an
  existing release fixture. During development, record
  `journal-unreleased.json` with `bun scripts/record-journal-fixture.ts --unreleased`;
  `--unreleased --force` refreshes only that development fixture. Evaluation reports follow
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

Releases run in GitHub Actions. All 24 publishable packages share version
`0.16.0` in source and publish together under npm's `latest` tag. Changesets
versions this fixed group; the release workflow publishes the isolated build
from `.artifacts/packages`, whose manifests have `private: false`.

### Release PRs

1. Add a changeset with `bun run changeset` in a package-change PR. Choose
   the affected package and patch, minor or major intent. The fixed group
   makes every framework package take the same resulting version. Keep the
   usual entry under **Unreleased** in `CHANGELOG.md` too.
2. After changesets reach `main`, `release-pr.yml` runs `release:version`
   and opens or updates `changeset-release/main`. It consumes the notes,
   synchronizes package and plugin versions, updates the central changelog
   and version markers, records the new journal/run fixtures and regenerates
   docs. Existing source-package visibility is preserved, including private
   packages such as core. Changesets versions the whole group, while the
   framework publisher handles distribution artifacts.
3. Review and merge the generated PR, titled `release <version>`. The bot
   explicitly dispatches the existing `ci` workflow on its branch so its
   required check can run with `GITHUB_TOKEN`. Branch protection still
   requires that check to pass before merging.
4. After the merged release commit passes main's `ci`, `release.yml`
   verifies its source SHA, version, dated changelog, compatibility fixtures
   and the trusted Actions check. It builds and verifies the packed packages,
   runs the publishing dry run, publishes in dependency order, confirms every
   version on npm, pushes `v<version>`, creates the GitHub release and
   dispatches the docs deployment at that tag. Its separate `landing` job
   then publishes the release README as the unscoped `efferent` package.

Merging the release PR signs off on package publication, the immutable tag
and documentation deployment. Ordinary feature commits retaining the current
version do not publish. A Changesets note is unnecessary for repository-only
changes that should not bump the framework version.

For the already prepared `0.16.0` release, or to retry an interrupted release,
run the workflow on GitHub's Actions tab, or dispatch it:

```sh
gh workflow run release.yml --ref main -f version=0.16.0
```

The workflow resolves the original `release <version>` commit on main,
checks its exact successful CI run, and publishes that clean source even
when the pipeline code has advanced. If history contains more than one
release commit for that version, pass `-f commit=<full-sha>` explicitly.
Publication never runs from an arbitrary PR or a commit outside main.

### npm authentication

The first publication of new package names needs an npm granular token.
Create a short-lived token with package/scope read and write (publish and
stage), access to `@xandreed`, and bypass 2FA. Save it directly as the
repository Actions secret `NPM_TOKEN`; do not put it in a file or a PR.
Package settings must permit token publication. A stage-only token does not
perform this workflow's direct publication.

For ongoing releases, configure npm trusted publishing for each package:
GitHub owner `xandreeddev`, repository `efferent`, workflow `release.yml`,
with permission to publish directly. No environment name is required by
this workflow. Use npm's current trusted-publisher setup instructions,
then remove `NPM_TOKEN`. The job grants `id-token: write` and uses npm
11.15.0 on Node 24. npm automatically uses OIDC when no token is supplied;
`npm whoami` does not validate OIDC, so CI checks that account only for
explicit token authentication. Local publishing retains its account check.

Also configure that trusted publisher for the unscoped `efferent` package.
It reserves the project's npm name and publishes only the release README,
license and package metadata. Its separate `landing` job runs after the
framework release, using the same verified version and source commit. The
README points to the scoped framework packages; its repository links target
that exact source commit so they also work on npm. It has no runtime API,
commands or dependencies. Versions through 0.6.1 contain the historical CLI.

To inspect the landing package locally without uploading:

```sh
bun run publish:landing
```

This builds and packs the isolated `.artifacts/npm-landing` directory.
Uploads require `--ci --publish` and run through `release.yml`. Retrying an
existing release skips the landing version only when both its source commit
and packed integrity match. A retry can add a missing landing version
without republishing the framework packages or moving the release tag.

See [npm token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
Tokens are a bootstrap path; npm's direct token-publishing policy changes
in January 2027 make trusted publishing the ongoing path.

### Integrity and recovery

The publisher keeps the build/HEAD, clean-tree, shared-version, dependency
order and immutable-tag checks. Built manifests record `gitHead` and the
repository URL. An existing release can resume only when npm's core version
records the same source commit. Missing provenance cannot establish a safe
resume, and another same-version checkout is refused.

Every registry read and upload uses `https://registry.npmjs.org` explicitly.
After an ambiguous npm failure, the publisher checks the registry for about
a minute before deciding whether the upload succeeded. A retry uses the same
source commit and skips versions already uploaded. It never moves a pushed
release tag. The workflow uses one publication concurrency group and does
not cancel a release in progress.

The source and pipeline checkouts are separate, so a historical release can
use the current CI publisher without changing its source or build stamp.
Both GitHub token-created release PRs and tag pushes need explicit workflow
dispatches: CI is dispatched on the release branch, and `docs.yml` on the
published tag. The docs deployment is therefore after all npm versions are
confirmed, including when the tag was pushed with `GITHUB_TOKEN`.
For historical checkouts, npm's provenance records the verified source SHA;
the workflow identity and run still identify the current publishing pipeline.

`bun run release:publish` remains available for an explicitly requested
interactive recovery. Routine releases and the initial release above run
through GitHub Actions.

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
