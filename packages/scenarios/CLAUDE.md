# @xandreed/scenarios

**Evals v3** (`docs/evals-v3.md`, adapted to the new line): the unit is a
SCENARIO — ordered steps over a booted WORLD — and the evidence (event trail,
persisted conversation, workspace fs) is data the checks read. The TOP of the
new line's dependency graph: packs may import the agent packages; nothing
imports scenarios.

```bash
bun run scenarios [pack …] [--mode scripted|live] [--json]
bun run scenarios -- --update-baselines     # rewrite the committed ratchet files
bun run scenarios -- --no-check             # skip the baseline comparison
```

- **framework/** — `model` (Scenario/Step/Check/Judge/Pack; worlds erased by
  PRE-BINDING the runner, no casts), `run` (scoped boot → step fold — a hard
  check failure fail-closes the rest — → judges in live mode; every failure
  captured, never thrown), `evidence` (fileExists/fileContains · eventOrder/
  eventCount/eventWhere · toolSequence/turnAlternationValid/briefContains).
- **packs/** — one per agent. `smith-spec`: the refine → lock → forge
  pipeline; the SCRIPTED twin (smith's `RefineAgent` + `runForgeSessionWith`
  seams + foundry's scripted implementor) runs key-free in CI and proves the
  harness wiring end-to-end — spec file lifecycle, event order, spec checks
  becoming accept gates, the reject→fix→accepted loop. Live scenarios ride
  the same checks with the real model (key-gated).
- **baselines/** — committed `<pack>.<mode>.json` ratchet files, compared BY
  DEFAULT when present (a mean drop beyond 0.05 exits non-zero);
  `--update-baselines` is the explicit, PR-reviewed update.

Each agent PR ships its pack additions + baseline updates — the
full-scenario battery is part of the agent's definition of done. v1
simplifications: no bootstrap-CI stats (tolerance gate instead), no samples/
pass@k yet, judges wired but no pack uses them — add with the first live pack.

`bun test packages/scenarios` — framework semantics (hard-fail stops, soft
continues, mode skip, captured act failures, evidence combinators, pack
means). ZERO-entry ratchet baseline like every new-line package.
