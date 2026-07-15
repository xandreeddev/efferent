# Social drafting campaign v1 — 2026-07-15

48 live trials: 2 models × 2 efforts × 6 fixture threads × k=2 — **the first
measurement of the social agent's model output ever** (the scripted pack
proves plumbing; it never invokes a model). Every trial runs the REAL loop
(prompt 2.0.0, toolkit, Gate A, ledger) over a recorded fixture thread with
stub ports — `postTweet` DIES, so a trial can never touch X. Evidence:
`.efferent/evals/social-matrix-campaign-v1.json` + `…-evidence/trials/`.

## What was fixed before the campaign

1. **The self-link mandate, killed** (prompt 2.0.0): the old prompt REQUIRED a
   blog link in every reply — the exact "check my blog" pattern its own
   banned-phrases gate exists to stop; 5/5 live-ledger drafts carried a link.
   Links are now EARNED: only when one post directly answers the thread and
   the reply stands without it. Abstaining is explicitly a good outcome.
2. **The thesis, actually encoded**: Effect.ts services/Layers, colocated
   evals, the harness living inside the codebase, receipts over opinions —
   the old prompt said only "Effect.ts blog, zero hype".
3. **Versioned prompt** (`SOCIAL_PROMPT_VERSION`, pack meta + baseline) — the
   ritual now applies to social like every other agent.
4. **Jittered scans**: the daemon's fixed 2h metronome (an OPSEC tell the
   roadmap explicitly flags) now rides `Schedule.jittered`.

## Fixtures

Three draft-worthy threads (Effect retries question, agent-evals skepticism,
where-do-prompts-live), one judgment call (a DI hot take), two must-abstain
(React CSS help, crypto hype-bait). Scorers: draft/abstain decision
discipline, Gate-A first-try pass, self-link rate (penalized above 50%),
read-thread-before-draft trajectory, latency, and a general-tier judge
(substance / context fit / thesis voice; generic or embarrassing halves the
score; ANY alias-identity leak zeroes the candidate).

## Results

| candidate | discipline | gate-A first-try | self-link rate | judge | turn p50 |
| --- | --- | --- | --- | --- | --- |
| **luna / medium** | **1.00** | 0.75 | **0.13** | **0.93** | **8.4s** |
| luna / low | 1.00 | 0.71 | 0.14 | 0.88 | 11.7s |
| glm-5.2 / medium | 0.75 | 0.60 | 0.40 | 0.71 | 47s |
| glm-5.2 / low | 0.75 | 0.40 | 0.60 | 0.87 | 44s |

No candidate leaked identity. Sample draft (harness-location, judged 5/5/5):
*"Keep prompts and evals in the same repo as the harness, beside the code
they grade. Commit scenario packs and baselines; run deterministic evidence
checks in CI so prompt changes get reviewed like code, not drift in Notion."*

## Verdict

**Pinned: effort MEDIUM** (`CurrentModelCallPolicy` around the drafting loop
in `opportunityFinder`); the model follows the general role (today
`openai-codex:gpt-5.6-luna`). Luna/medium is the only candidate with perfect
draft/abstain discipline AND an earned-only link rate; glm-5.2 drafts on
spam-bait fixtures (0.75 discipline = reputation risk), links 40–60% of the
time, and runs 5× slower. Re-run `bun run evals:social-matrix` before
trusting any general-role change.

## Follow-ups

- Link rate may have over-corrected (0.13 vs the two link-EARNED fixtures) —
  if blog traffic matters, tune the earned-link line and re-screen; substance
  scores did not suffer.
- Content-similarity dedup (n-gram across drafts to DIFFERENT targets)
  remains unbuilt — the matrix measures per-trial, not cross-draft
  self-similarity over time.
- Scan targeting is still a fixed 5-query list with no opportunity ranking
  (the S5 finder-scoring design) — the matrix grades drafting, not scouting.
- samples=2; re-screen at k≥3 before any future re-pin.
