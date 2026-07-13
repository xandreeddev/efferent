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
├── ui-agent/     the reusable governed UI AGENT (ui-agent → engine): typed
│                 page/component/theme/protocol entities · a 60+ component core
│                 catalog + evolutionary admission/deduplication · incremental
│                 start/patch/prop/component/theme channels · versioned pinned
│                 planner/composer/repair profile · host, page-store, catalog,
│                 and theme-store ports. It emits data, never source markup.
├── surface/      the trusted UI compiler (surface → ui-agent): html template ·
│                 semantic DesignTokensV2/theme CSS compilation · governed
│                 component graph + constrained template AST → escaped HTML ·
│                 typed blocks/graphs + versioned landing/app/doc recipes
│                 → accessible server-side SVG (Dagre) · legacy allowlist
│                 sanitizer and validateUi gates for read-only old Canvas pages
│                 and other existing consumers
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
├── canvas/       the first UI-agent HOST (canvas → ui-agent+surface+providers):
│                 HTMX-over-WS shell, SQLite page/catalog/theme adapters,
│                 component gallery + theme lab, registered assets/actions,
│                 CSRF/origin enforcement, CSP Alpine behaviors, and legacy
│                 raw-page replay. No raw authoring fallback.
├── issue-tracker-example/ the reference Effect architecture and safe Smith
│                 eval world: Schema entities + paired behavior, use-case
│                 contracts + paired programs, Context.Tag ports, Layer
│                 adapters, and a composition-only main.
└── scenarios/    evals v3 (top of the graph — imports agents): scenario packs
                  over agent worlds — ordered steps, deterministic evidence
                  checks (event trail / persisted conversation / workspace),
                  committed baselines compared BY DEFAULT. The scripted twins
                  run key-free in CI.
```

**Dependency direction is enforced by the boundaries gate**
(`foundry.config.ts`): engine/foundry import nothing internal; ui-agent →
engine; surface → ui-agent; providers → engine; hosts → agent+renderer;
scenarios may import agents;
nothing imports scenarios.

## Conventions (gate-enforced, ZERO baseline)

`bun run typecheck` = the canonical repo profile (static architecture + tsc), and
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
- New domain/application features use qualified pairs: `thing.entity.ts` +
  `thing.entity.functions.ts`, and `do-thing.usecase.ts` +
  `do-thing.usecase.functions.ts`. Entity/use-case contracts contain Schema
  definitions and derived types; behavior lives in the paired functions file.
  Ports end in `.port.ts`; adapters end in `.adapter.ts` and may bridge foreign
  promises only through `Effect.tryPromise`. Raw Promise orchestration,
  runtime imports, `Effect.run*`, and Layer construction never enter the core.
- **After any task, run `bun run typecheck`** — a banned construct or a fresh
  finding fails the command and the change is rejected. CI additionally runs
  `bun test`, `bun run foundry demo` (the forge-loop E2E), and
  `bun run scenarios` (the scripted packs vs committed baselines).

## Running the agents

Credentials come from `~/.efferent/auth.json` (per-provider `api_key`/`oauth`
entries); general agent model selection comes from `.efferent/config.json`
(`"model": "<provider>:<modelId>"`, plus `codeModel`/`fastModel` roles;
local-over-global merge). `EFFERENT_MODEL` is deliberately ignored — the
launch dir's `.env` must never silently pick the model.

The UI agent is the exception: its model planner/composer/repair selections,
incremental wire protocol, and effort/token/timeout/fallback policy are pinned in
`packages/ui-agent/profiles/streaming-ui-v1.json`. Startup rejects profile drift; do
not replace it with the global roles. Profile or prompt changes require the
model × effort × protocol matrix through the real Canvas browser path, review of
desktop/mobile screenshots and persisted failures, and a baseline update. The
matrix persists every settled trial immediately (the report's `trials/` dir)
and contains provider errors AND runtime defects as failed rows — evidence
survives a dead campaign and one broken candidate never aborts the rest.

```bash
bun run smith "<task>" --cwd <dir> [-p]        # shorthand: trivial locked spec + forge
bun run smith spec "<idea>" --cwd <dir>        # refine → :lock → :forge (TTY TUI; -p headless)
bun run smith forge <slug> --cwd <dir> [-p]    # forge a LOCKED spec
bun run math [--grade <n> --theme "<t>"] [--open]   # the practice product (loopback + token)
bun run canvas [--port <n>] [--open]           # the page builder (loopback)
bun run social test|review|daemon              # scan (supervised) · human queue · scheduler
bun run scenarios [pack…] [--mode scripted|live]    # the regression batteries
bun run evals:ui-matrix [--samples <n>]             # model × effort × protocol browser evidence
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
