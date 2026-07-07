# The spec-driven coder (smith v2) + the CLI reshape

**Oracle: strong** — typecheck, tests, and static rules are free deterministic
ground truth. The harness effort goes into the SPEC (so the gates judge the
right thing) and the loop (foundry's forge — already built).

## Part 1 — smith v2: spec → refine → lock → forge

The pipeline: a rough idea becomes a **SpecDoc** (drafted by a refiner agent,
refined WITH the human, locked by the human), and only a locked spec forges.
The spec is the contract; the gates are its mechanical enforcement.

### The SpecDoc artifact

`<workspace>/.efferent/specs/<slug>.md` — git-committable provenance (the
persisted `FactoryRun.spec` ties back to it). YAML frontmatter is the machine
half; strict markdown sections are the human half:

```markdown
---
version: 1
status: draft            # draft | locked
created: <iso>
locked: <iso>            # present only when locked
limits: { maxAttempts: 3, budgetMinutes: 15 }
gates:                   # optional — overrides workspace suite discovery
  config: foundry.config.ts
  testCommand: "bun test --filter stats"
  noTest: false
checks:                  # machine-checkable acceptance → rank-2 command gates
  - { name: "stats-tests", command: "bun test src/stats.test.ts" }
---
# Goal
One imperative paragraph.

## Acceptance
- criterion (verbatim into the implementor brief; machine-checkable ones carry a check)

## Constraints
- what must not change / house rules

## Non-goals
- explicit scope fences
```

Deterministic round-trip codec (`parseFrontmatter` + a strict section grammar);
humans edit the file directly, the codec re-decodes it. Constraints/non-goals
render into the implementor brief only — foundry's `Spec` stays
`{goal, acceptance, limits}` (foundry untouched).

### Layering

SpecDoc schema/codec + the refiner agent core live in **sdk-core** (the CLI's
`:spec` reuses them; the cli may never import smith — foundry's `typescript`
dep stays out of the npm bundle). Smith owns only the SpecDoc→`Spec` mapping
and the drivers.

- sdk-core: `entities/SpecDoc.ts` (+ `renderSpecSection` — the Directive
  replacement), `usecases/specCodec.ts`, `usecases/specRefiner.ts`
  (**`propose_spec` is the ONLY way the draft changes** — schema-validated
  params → encoded file write; toolkit = read-only workspace tools +
  `propose_spec`), `prompts/specRefiner.ts` (explore first; ≤3 numbered
  questions per turn; machine-checkable criteria MUST carry a `check`;
  unattended variant records assumptions as constraints).
- smith: `smith spec "<idea>"` (refine session; `-p` one-turn draft, `--yes`
  locks) · `smith forge <spec|slug>` (locked only; a draft is a `ConfigError`)
  · `smith "<task>"` (trivial SpecDoc auto-locked + written — provenance even
  for shorthand) · bare `smith` on a TTY boots refine mode with an empty
  composer. `checks[]` become `accept:<name>` command gates appended to the
  suite. Gate-config precedence: CLI flags > spec frontmatter > workspace
  discovery. TUI gains a refine mode (transcript + live SpecPanel + a real
  composer; `:`-input still commands) and `:lock` / `:forge` / `:spec`.

### Gate list

Enforced (per forge attempt, the existing staged pipeline): workspace suite
(typecheck / tests / static rules from `foundry.config.ts` discovery) + one
rank-2 `accept:<name>` command gate per SpecDoc check. Fail-closed; findings →
`renderFeedback` brief → same conversation retry, bounded by `limits`.
Enforced (refine): the draft changes only through `propose_spec` (schema
validation at the tool boundary); only the human locks. Eval-only: refiner
quality (does the spec capture the ask?) — future suite.

## Part 2 — the CLI reshape (RESCOPED 2026-07-07: freeze, don't reshape)

**Decision (superseding the R2–R4 plan below):** the old CLI is FROZEN — R1's
excision lands (plus the mechanical compile fixes it forces in `packages/cli`),
npm `efferent` keeps publishing as-is, and **no further CLI reshaping happens**.
R2's `:spec` sessions exist on the new line as `smith spec`; R3's deterministic
definition-of-done IS smith's forge loop; R4's default flip is moot for a frozen
surface. Every new agent (education, social, ui-builder) is built as its own
package on the smith pattern (sdk-core + adapters + foundry, never cli). A
future thin CLI can grow out of smith's chassis when it's earned. R2–R4 below
are kept for the record only.

- **R1 — excise**: delete `ports/Verifier` + `ClaudeHeadless*`/`Unavailable*`
  verifiers, `gateLoop`, `autoLoop`/`maxLoopAttempts`, the driveLoop mandatory
  swarm-gate block, `autoDistill`/`distill`/`efficiencyGate`/`persistArtifact`
  + the `distill` CLI + `learned`/`gate` events, `Directive` + `:goal`/`:verify`
  + `VERIFIER_AGENT`, `verifierGate.ts`. Learning goes ENTIRELY — unverified
  persistence is the advisory anti-pattern; `.efferent/skills|memory` remain as
  user-curated assets. `gate_verdicts` migrations stay (append-only history);
  the table becomes read-only audit. The ratchet baseline SHRINKS.
- **R2 — `:spec` sessions**: a session carries a locked SpecDoc
  (`renderSpecSection` where the directive section was; Workspace protocol +
  HTTP routes; `:spec refine <idea>` runs the sdk-core refiner in the normal
  conversation — the composer IS the refine dialog; `:spec lock`).
- **R3 — deterministic definition-of-done**: `workspaceGates.ts` over the
  Shell port runs the workspace's gate suite as a SUBPROCESS (in-repo:
  `bun packages/foundry/src/main.ts check --config …`; elsewhere:
  `Settings.gatesCommand`; unset → off) at the tail of `driveLoop` when the
  turn touched files. Fail → findings tail as a feedback message → re-run,
  bounded by `Settings.gatesMaxRounds` (default 2) → exhaustion delivers with
  a red `gates` rail event. The exit code is the verdict; no LLM judges.
- **R4 — defaults + docs**: `agentMode` default swarm→**direct** (the
  coordinator's gate phase died in R1; the fleet stays one `:set` away);
  `docs/self-improving-loop.md` marked superseded by foundry; AGENT.md sweep.

Verification per PR: `bun run typecheck` (baseline only shrinks) + `bun test`
+ `efferent verify` tier A + live keyed smoke (R3: a gated turn on the
efferent repo itself).
