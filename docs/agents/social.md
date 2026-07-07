# The social engagement agent (X / @xandreeddev)

**Oracle: weak** — "good engagement" is subjective, outward-facing, and
irreversible. Trust is bought with policy gates + a human approval queue +
evals, and the human stays in the loop longest here. Volume is never the
goal; rate-disciplined, genuinely-relevant engagement is both the compliance
constraint (platform-manipulation rules) and the brand constraint.

## What exists (keep both structural guarantees)

`packages/social`: Playwright-only X access over the alias-bound persistent
profile; the agent's toolkit is DRAFT-ONLY (`write_draft` — the model cannot
post, structurally); a human review queue (`social review`:
approve/edit/discard/skip) is the one hard gate; drafts are markdown files
under `posts/drafts/{pending,posted,discarded}`. Known holes: dedup only
checks `pending/` filenames (posted/discarded tweets can be re-drafted), no
rate caps / blocklists / banned-words / per-author caps, policy lives in the
prompt ("DO NOT SPAM" — advisory), the review `[e]dit` path can post >280
chars unvalidated, no outcome tracking, and the package is ungoverned by the
repo gates.

## The third guarantee (net-new)

**Nothing enters the queue, and nothing leaves for X, without passing the
deterministic gate pipeline.** Gates are pure functions
`(draft, ledgerIndex, policy, trajectory) → Finding[]` using foundry's
Finding/`toVerdict`/`renderFeedback` shapes verbatim, fail-closed (an
unreadable ledger or malformed policy file is an error finding — a broken
harness never passes drafts). Two chokepoints:

- **Gate A (pre-queue)** — inside the `write_draft` handler
  (`failureMode:"return"`): a failing draft bounces back to the model with
  findings; the per-candidate loop's remaining steps are the bounded
  regeneration; no accepted draft → candidate ledgered `skipped` and dropped.
- **Gate B (pre-post)** — in the review queue's approve path, AFTER any human
  edits (fixes the >280 bug), plus post-time re-checks of rate caps + dedup.

## Gate list

**Enforced (A, re-run at B where content-shaped)**: dedup vs the LEDGER
(forever, all actions) · daily cap (default 6) · hourly cap (default 2) ·
per-author cap + cooldown (1 per author / 14 days) · author blocklist ·
banned words/topics · t.co-weighted length ≤280 · ≤1 mention (target author
only) · link-domain allowlist (default `xandreed.dev`) · **thread-context
trajectory gate** (a reply's drafter must have called the new `read_thread`
tool for the target tweet BEFORE drafting — checked from the captured
trajectory) · blog-slug-exists. **Advisory** (review UI annotations): draft
age >24h; n-gram similarity to previously posted replies (spam smell).
**Eval-only** (`social` suite: fixture threads + stubbed XPlatform): brand-
voice judge (anchored rubric + labeled real examples), reply-relevance judge,
"would this embarrass the alias" judge, plus the same pure gates as predicate
scorers — one implementation, two harnesses.

## The engagement ledger

Append-only JSONL (`posts/ledger.jsonl`), one Schema.Class row per event:
`{tweetId, author, action: drafted|queued|posted|discarded|skipped|
gate_rejected|post_failed, draftFile?, at, gateFindings[], outcome?}`.
Dedup/caps/graduation all fold the ledger; `O_APPEND` single-line writes make
the scan-daemon/review race benign; human-inspectable next to the drafts.
(SQLite rejected: the shared store's dual-dialect migrations are the wrong
coupling for a private package's tens-of-rows-per-day concern.)

## Orchestration + persistence

The scan loop stays a standalone daemon (the runtime cron's `submitJob`
spawns coder-shaped agents — the wrong unit; the roadmap's trigger files are
the eventual front door) but adopts sdk-core's cron parsing **with ±15min
jitter — never a metronome** (OPSEC). The bespoke `runAgentLoop` becomes
`runAgent` + `ConversationStore`, one conversation per candidate — drafts
become auditable in `:browse` and the trajectory gate reads a persisted
record.

## Graduation (design; a pure predicate over the ledger)

Only the `post` class may EVER auto-post: 20 consecutive approved-without-edit
posts + zero Gate-B rejections in the window + the social eval green →
auto-post capped 1/day, still Gate-B'd, still ledgered; any discard/edit
resets probation. **Replies never graduate** — a reply lands in someone
else's thread; it is precisely where the oracle is weakest and the blast
radius largest.

## PR phasing

S1 ledger + policy file + 11 pure gates + repo-gate governance (social enters
`foundry.repo.config.ts`: CHECKED + boundaries layer canImport
core+adapters+foundry; existing code baselined, new code clean) →
S2 chokepoints (Gate A in `write_draft`, `XPlatform.readThread` + tool,
Gate B post-edit, maxSteps 5→8) → S3 the `social` eval suite (evals v2) →
S4 cron+jitter + runAgent/ConversationStore migration → S5 outcome metrics
scrape → ledger enrichment → finder scoring + the graduation predicate.
Verification: every gate unit-tested per failure mode; supervised live scans
in review mode only until S5's data exists.
