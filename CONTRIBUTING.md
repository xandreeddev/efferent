# Contributing to efferent

## Releasing (Changesets)

The monorepo publishes four packages to npm, **independently versioned** via
[Changesets](https://github.com/changesets/changesets):

| Package | What |
| --- | --- |
| `efferent` (+ `@xandreed/cli` mirror) | the CLI — a Bun bundle |
| `@xandreed/sdk-core` | pure Effect.ts domain (runtime-agnostic) |
| `@xandreed/sdk-adapters` | Layer implementations of the core ports |
| `@xandreed/evals` | the reusable eval framework |

### Authoring a change

When your PR changes a publishable package, add a changeset:

```bash
bun run changeset      # pick the packages + bump level (patch/minor/major), write a summary
git add .changeset && git commit
```

Commit the generated `.changeset/*.md`. No changeset = no release for that package
(fine for docs/test-only/internal-package changes — `social`, `website`, `examples`
are private and never published).

### How a release happens (automatic)

1. Your PR (with its changeset) merges to `main`.
2. The `release` workflow opens/updates a **"Version Packages" PR** that bumps the
   affected packages, writes their `CHANGELOG.md`, and refreshes `bun.lock`.
3. **Merging that PR publishes**: the workflow runs `bun run release` — typecheck +
   tests, then builds the libs (`tsc -b`) + the CLI bundle, then `scripts/publish.ts`
   publishes every package whose `name@version` isn't already on npm (via npm
   **trusted publishing** / OIDC, with provenance) and tags + creates the GitHub
   releases.

You never hand-edit a version or run `gh release create`.

### Build vs publish

- **Dev needs no build** — Bun runs the TypeScript source directly (the libs'
  `exports` point at `./src`, resolved via the workspace + tsconfig `paths`).
- The libs build to `dist/{*.js,*.d.ts}` (`bun run build:libs`, `tsc -b`) **only for
  publishing**. `scripts/publish.ts` rewrites each lib's manifest at publish time —
  `exports`/`main`/`types` → `dist`, and `workspace:*` deps → real `^` ranges — then
  restores the dev manifest. The committed manifest always stays dev-facing.
- Dry-run the publisher any time (it builds what it needs): `bun scripts/publish.ts --dry-run`.

### One-time npmjs.com setup (maintainers)

Auth is OIDC trusted publishing — **no token secret**. For each published name
(`efferent`, `@xandreed/cli`, `@xandreed/sdk-core`, `@xandreed/sdk-adapters`,
`@xandreed/evals`): npmjs.com → the package → Settings → **Trusted Publisher** →
GitHub Actions → owner `xandreeddev`, repo `efferent`, workflow `release.yml`.

**Bootstrap (brand-new scoped names only):** OIDC can't create a package that
doesn't exist yet, so each new name needs ONE manual publish first:

```bash
bun run build:libs
cd packages/sdk-core && npm publish --access public   # then sdk-adapters, evals
```

(Use `npm login` + an OTP for these.) After the name exists and its trusted
publisher is configured, every subsequent release is fully automatic.
