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
bun run typecheck     # tsc + foundry self-check + the zero-baseline repo gate suite + scripts/
bun test              # colocated unit tests — key-free by design
bun run foundry demo  # the forge-loop E2E over a scripted implementor
```

The tests expect no proxy in the environment: Bun's fetch sends even the
loopback servers they start to `HTTP_PROXY` / `HTTPS_PROXY`, so run them with
those unset (the proxy tests that would go direct skip when one is set).

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
- A change to an event or a stored payload runs `bun run docs:generate`
  (the plugin and [event](docs/event-reference.md) references are committed
  as generated) and must keep every release's journal fixture readable
  (`packages/sdk/src/journal-compat.test.ts` reads each
  `packages/sdk/fixtures/journal-<version>.json`). A fixture records what a
  release wrote: record one per release with
  `bun scripts/record-journal-fixture.ts`. It refuses to overwrite an
  existing fixture unless `--force` is passed, and `--force` is only for
  re-recording the current, unreleased version.
- Add an entry under **Unreleased** in `CHANGELOG.md`: what changes for
  someone using the packages, with a migration note for anything breaking.
  Repository-only changes go under its "Repository" heading.

## Publishing

The framework packages are published from a maintainer's terminal; there is
no release automation, and publishing needs explicit sign-off. All 19
publishable packages share one version (`0.13.0` in the sources) and are
published under npm's `latest` tag. The previously published `efferent`,
`@xandreed/cli` and `@xandreed/sdk-*` packages are a frozen earlier line.

For a release, set the new version in every publishable `package.json` and in
each plugin definition (`version:` in `definePlugin`), run
`bun run docs:generate`, and turn the changelog's **Unreleased** section into
the new version, with the release date. Set the version in the README's and
the website getting-started page's "published at" sentence, and drop the
README's exception for packages not yet on npm (today
`@xandreed/plugin-workspace` and `@xandreed/plugin-telemetry`; npm holds
older `@xandreed/plugin-telemetry` versions from an earlier line, so check
with `npm view @xandreed/plugin-telemetry versions` that none is at or above
the new version). Merge that, then publish from a clean
checkout of the merge commit:

```sh
bun install --frozen-lockfile
bun run build:packages            # also writes .artifacts/packages/build.json
bun run verify:packages
bun run publish:packages          # dry run: every check, then npm publish --dry-run
bun run publish:packages --publish
```

The distribution build resolves `workspace:*` dependencies to the matching
package versions and stamps `build.json` with the commit, whether the working
tree had changes, the shared version and the packages it built. Changes are
tracked and untracked files anywhere, plus gitignored files in a package's
`src`, `skills` or `profiles` folder, which the build copies too.
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
release (`v<version>`) after it is on npm. Tags resume with `v0.13.0`; 0.11.0
and 0.12.0 have none.

Never publish from a commit whose version is already on npm for some
packages, unless it is the commit those were published from (a run that
stopped part-way). The skip above would then publish only what is missing,
such as a package added since that release, pinned to the published
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

Run `bun run build:packages` and `bun run verify:packages` for package changes.
The external-consumer test installs local tarballs; it never publishes them.
Run `bun run --cwd packages/website check` for documentation changes.
