# efferent — the agent line on Effect.ts + Bun

**A family of purpose-built agents on a shared kernel**, each one built to the
harness doctrine: *Agent = Model + Harness; validation and looping are
ENFORCED in deterministic code, never advisory; the gate declares victory,
not the model; validation-oracle strength drives harness investment.* Built
in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader
project rules — alias identity, OPSEC, weekly cadence. Plan docs live under
`docs/agents/`; the eval revamp under `docs/evals-v3.md`.

**History (2026-07-07, THE DROP):** the original runtime (`sdk-core` /
`sdk-adapters` / `cli` / `web` / `evals`) was frozen, its learnings
re-authored into the packages below, and then DELETED. The published npm
package `efferent` (the old CLI) remains on the registry but no longer
receives updates; its `examples/` were removed 2026-07-08 and
`packages/website` now documents THE CURRENT LINE (Astro, deploys to GitHub
Pages via docs.yml). Everything current is source-run (`bun run <agent>`).

## Architecture

```
packages/
├── foundry/      THE FIXED POINT — the factory: forge loop (implement →
│                 snapshot → gate pipeline → typed feedback → retry) +
│                 static-analysis gates + the ratchet baseline machinery.
│                 Imports nothing internal. docs/foundry.md
├── engine/       the agent KERNEL (pure; effect + @effect/ai only):
│                 entities · ports (ConversationStore/SettingsStore/AuthStore/
│                 FileSystem/Shell/UtilityLlm) · the loop (an Effect.iterate
│                 fold; malformed-response recovery; degenerate-loop breaker;
│                 typed partial outcomes) · prompt mapping (provider-blob
│                 round-trip, deterministic tool-call ids, the Anthropic usage
│                 fold) · the session chassis (seq'd event ledger, serialized
│                 send, replay-then-live subscribe) · the SpecDoc + codec
├── providers/    the EDGE (providers → engine): the routed LanguageModel
│                 (re-resolves .efferent/config.json selection + auth.json key
│                 PER CALL; OpenAI-compatible client for the opencode gateway;
│                 anthropic subscription auth + cache breakpoints; transient
│                 retries, 300s timeout, empty-response rejection) · SQLite
│                 conversation store · local auth/settings · fs/shell
├── surface/      the UI substrate (pure): the html tagged template · the
│                 allowlist sanitizer (the security boundary; attack tests are
│                 the spec; opt-in alpine mode admits x-*/@*/:* directives,
│                 never x-html/x-teleport/URL binds) · sanitizeMathml ·
│                 validateUi (the FEEDBACK boundary: dangerous-vocabulary /
│                 hx-wiring / a11y-min / no-arbitrary-values / no-self-trigger
│                 / alpine-expr) · protocol contract
├── smith/        the CODER at the forge (smith → engine+providers+foundry):
│                 spec-driven — refine (propose_spec is the only write; the
│                 human :locks) → forge with the engine's DIRECT coder as the
│                 Implementor (read/write/edit/Bash/grep/glob/ls, writes
│                 cwd-guarded) → the gates judge. No fleet, no judge-gate:
│                 refine is the prompt engineering, the gates are the verdict.
├── math/         the education product (math → engine+providers+surface):
│                 the tutor authors exercises through render_math; the SERVER
│                 grades instantly against each exercise's own key (exact
│                 rational arithmetic); admission gates bounce malformed items
│                 to the model as data. Owns its views/assets end to end.
├── social/       the engagement agent (social → engine+providers): draft-only
│                 toolkit, HUMAN review queue, 11 deterministic policy gates
│                 at write_draft AND pre-post, append-only JSONL ledger as the
│                 dedup memory. Replies NEVER graduate to auto-post.
├── canvas/       the ui-builder (canvas → engine+providers+surface): builds
│                 interactive PAGES from natural language; render_ui is the
│                 ONE output channel (an HTML-in-chat reply is bounced) and
│                 every call runs surface's UI gates — a violation bounces
│                 with the findings; no fs/shell/code tools at all. Pages =
│                 the cv-* design system + htmx-over-WS for agent actions +
│                 vendored Alpine.js for page-LOCAL state (timers/toggles),
│                 CSP-pinned. No React ever.
└── scenarios/    evals v3 (top of the graph — imports agents): scenario packs
                  over agent worlds — ordered steps, deterministic evidence
                  checks (event trail / persisted conversation / workspace),
                  committed baselines compared BY DEFAULT. The scripted twins
                  run key-free in CI.
```

**Dependency direction is enforced by the boundaries gate**
(`foundry.repo.config.ts`): engine/surface/foundry import nothing internal;
providers → engine; each agent → its substrate; scenarios may import agents;
nothing imports scenarios.

## Conventions (gate-enforced, ZERO baseline)

`bun run typecheck` = tsc + foundry's self-check + the repo gate suite, and
the committed baseline is EMPTY — every rule violation anywhere fails:

- **Errors are values**: no `try`/`catch`/`throw`/`.catch()` — typed errors
  are `Schema.TaggedError`; foreign promises via `Effect.tryPromise` (or the
  two-arg `.then` for pure-promise fallbacks).
- **State is a fold**: no `let`, no loop statements — `Effect.iterate` /
  `Effect.reduce` / array combinators / `Ref`.
- **Absence is `Option`** (never `A | undefined` returns); union branching is
  `Match`; no `as any` / `as unknown as` laundering; entities are
  `Schema.Class`/`Struct` with branded id fields; no parallel interfaces.
- Tool failures are DATA: toolkits use the shared `Failure` struct with
  `failureMode: "return"` so the model corrects in the same run.
- Ports are `Context.Tag` services in the engine; adapters are one
  `<Thing>Live` Layer each in providers; composition happens at each agent's
  `main.ts` edge and nowhere else.
- **After any task, run `bun run typecheck`** — a banned construct or a fresh
  finding fails the command and the change is rejected. CI additionally runs
  `bun test`, `bun run foundry demo` (the forge-loop E2E), and
  `bun run scenarios` (the scripted packs vs committed baselines).

## Running the agents

Credentials come from `~/.efferent/auth.json` (per-provider `api_key`/`oauth`
entries); model selection from `.efferent/config.json`
(`"model": "<provider>:<modelId>"`, plus `codeModel`/`fastModel` roles;
local-over-global merge). `EFFERENT_MODEL` is deliberately ignored — the
launch dir's `.env` must never silently pick the model.

```bash
bun run smith "<task>" --cwd <dir> [-p]        # shorthand: trivial locked spec + forge
bun run smith spec "<idea>" --cwd <dir>        # refine → :lock → :forge (TTY TUI; -p headless)
bun run smith forge <slug> --cwd <dir> [-p]    # forge a LOCKED spec
bun run math [--grade <n> --theme "<t>"] [--open]   # the practice product (loopback + token)
bun run canvas [--port <n>] [--open]           # the page builder (loopback)
bun run social test|review|daemon              # scan (supervised) · human queue · scheduler
bun run scenarios [pack…] [--mode scripted|live]    # the regression batteries
bun run foundry check|demo                     # the gate suite / the forge E2E
```

Each agent persists its conversations to its own SQLite db under the
workspace's `.efferent/` (`smith.db` / `math.db` / `canvas.db`) — auditable
evidence; the scenario packs read the same trails as data.

## OPSEC reminder

Every commit under this tree must be authored as
`Xand Reed <xandreed@proton.me>` — verify with `git config user.email`. Never
reference the real name in any file, commit, comment, or screenshot. Never
add AI co-author trailers. Never commit anything from
`~/Workspace/xandreed/pi`. Cutting anything outward-facing (npm, the docs
site) happens only on explicit sign-off.
