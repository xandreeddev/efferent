# @xandreed/social

**The social engagement agent** (`docs/agents/social.md`) — finds X posts
worth a genuinely useful technical reply and drafts them into a HUMAN review
queue. Weakest validation oracle of the agent line, so the harness carries the
trust through THREE structural guarantees:

1. **The model cannot post.** Its only write tool is `write_draft` — a local
   markdown file in `posts/drafts/pending/`. Posting happens in the human
   review queue (`bun packages/social/src/main.ts review`), never by the agent.
2. **A human approves every engagement.** The `[a]pprove` path is the only
   route to `XPlatform.postTweet`.
3. **Nothing enters the queue or leaves for X without the deterministic policy
   gates** (`src/domain/gates.ts`, foundry's Finding discipline): dedup vs the
   ledger · daily cap · hourly cap · per-author cap + cooldown · author
   blocklist · banned content · t.co-weighted length ≤280 · ≤1 mention · link
   allowlist (xandreed.dev) · thread-context trajectory (a reply must have
   READ its thread via `read_thread`) · blog-slug-exists. **Gate A** runs
   inside `write_draft` (a rejection returns every finding to the model —
   fix or drop); **Gate B** re-runs on `[a]pprove` AFTER any `[e]dit`
   (the edit path used to post >280 raw) with post-time dedup/caps.

**The ledger is the memory** (`posts/ledger.jsonl`, append-only JSONL,
`src/domain/Ledger.ts`): one row per lifecycle event (drafted / gate_rejected /
posted / discarded / skipped) with content + findings. Dedup consults the
LEDGER forever — a discarded draft's target never re-engages; directory names
carry no state. **Policy is data** (`posts/policy.json` overlays the
conservative `DEFAULT_POLICY` in `src/domain/policy.ts`) — loosening a cap is
a reviewed edit, never a prompt change.

```bash
bun packages/social/src/main.ts test     # supervised scan: search X → evaluate → gated drafts
bun packages/social/src/main.ts review   # the human queue: [a]pprove(Gate B) [e]dit [d]iscard [s]kip
bun packages/social/src/main.ts daemon   # scheduled scans (see roadmap: cron + jitter)
```

## Layout (boundaries: social → core + adapters, never cli)

```
src/
├── main.ts        composition root (@effect/cli): daemon | review | test
├── domain/        paths · Ledger (append-only JSONL + pure views) · policy
│                  (Schema.Class + json overlay, fail-closed to defaults) ·
│                  gates (the 11 pure gates + runSocialGates + renderFindings)
├── ports/         XPlatform (search · notifications · readThread · postTweet)
│                  · BlogReader
├── adapters/      PlaywrightXPlatform (alias .playwright-profile session) ·
│                  AstroBlogReader (the blog's content collection)
└── usecases/      socialToolkit (draft-only tools; Gate A in write_draft;
                   read_thread caches the trajectory evidence) ·
                   opportunityFinder (scan → per-tweet agent runs) ·
                   reviewQueue (recursive review loop; Gate B before post) ·
                   scheduler
```

## Rules

- OPSEC: the Playwright profile is the ALIAS session. Never widen the link
  allowlist beyond alias-owned domains. Rate caps are ToS + reputation
  armor — the defaults are deliberately low; loosen only in `policy.json`.
- Replies NEVER graduate to auto-post (the S5 design keeps the human queue
  for replies permanently; only standalone `post` class may ever earn it).
- `packages/social/src/**` rides the repo ratchet with ZERO baseline entries.

## Testing

`bun test packages/social` — key-free: every gate's failure mode + the
accumulate case, ledger round-trip/corruption/windows, and the Gate A
chokepoint E2E (thread-context bounce → ledgered rejection; read_thread →
draft lands; dedup on re-draft) over stubbed ports + temp dirs. Live scans are
supervised and read-only on X (drafting is local).
