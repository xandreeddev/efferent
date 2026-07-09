# Contributing to efferent

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.2. No build step — Bun runs the TypeScript
source directly.

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

House rules the gates enforce (see the root `CLAUDE.md` for the full list):
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
The current line is source-run only. Any future publishing will be set up
deliberately, not resurrected from the old pipeline.
