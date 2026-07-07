# @xandreed/smith

**The agent in the factory.** A coding agent whose OUTER loop is
`@xandreed/foundry`'s `forge` — implement → snapshot → staged gate pipeline →
typed feedback → retry — and whose implementor is the REAL efferent coder
(`@xandreed/sdk-core` + `@xandreed/sdk-adapters`) run headless, every message
persisted to the same SQLite `ConversationStore` the CLI uses. Private,
source-run only (`bun run smith`); it is NEVER imported by `packages/cli`
(foundry depends on the `typescript` compiler, which must not enter the
published bundle) — the boundaries gate enforces both directions.

```bash
bun run smith "add a stats util with tests" --cwd ~/code/toy -p --allow-bash
bun run smith "<task>"          # TTY → the factory-floor TUI
```

Exit: 0 accepted · 1 rejected · 2 infra error. Artifact: `<cwd>/.foundry/runs/<id>.json`
(each `AttemptRecord.implementorRef` = `conversation:<uuid>` — open it in
`efferent` via `:browse`).

## Model roles (defaults — all overridable)

general `opencode:kimi-k2.6` (+ `openCodeThinkingMode: "high"`) · code
`opencode:kimi-k2.7-code` · fast `opencode:deepseek-v4-flash`. Configured
**exactly like the efferent CLI**: user `.efferent/config.json`
(local-over-global, `EFFERENT_MODEL`, `~/.efferent/auth.json` via `:login`
there) WINS over these defaults; `--model/--code-model/--fast-model` flags win
over everything (`settings/smithSettings.ts` — the overlay applies on READS
and never persists a smith default). The implementor root runs on GENERAL and
delegates code-heavy pieces to `role:"code"` sub-agents (the house code-tier
routing); smith also defaults `autoLoop: false` (the foundry pipeline IS the
gate — no Opus swarm gate), `agentMode: "direct"`, `maxSteps: 40`,
`subAgentMaxChildren: 4`, `subAgentMaxDepth: 1`.

## Layout (boundaries: smith → sdk-core + sdk-adapters + foundry, never cli)

```
src/
├── main.ts            argv fold → SmithRunConfig → composition root (cli AppLive minus
│                      TUI extras + BunContext) → TTY ? TUI (lazy import) : headless
├── domain/            SmithConfig (defaults + SmithRunConfig) · SmithEvent (the ONE union
│                      both hook families fan into: forge_* + gate_* + {type:"agent"})
├── settings/          the SettingsStore overlay (flags > user config > smith defaults)
├── implementor/       efferentImplementor (EfferentImplementorLive: Layer.scoped capturing
│                      the service Context so Implementor stays R=never; ONE conversation
│                      per forge run — retries continue it with the gate brief; receipt.ref
│                      links artifact↔conversation; runFleetToCompletion settles spawns;
│                      only INFRA failures → ImplementorError) · prompt (task/retry briefs)
│                      · filesTouched (tool_call_end → WorkspacePath)
├── gates/             commandGate (rank-2 test gate over Bun.spawn; crash = GateCrash,
│                      fail-closed) · suite (discovery: --config | foundry.config.ts |
│                      tsconfig→typecheck + package.json→bun test; zero gates = ConfigError)
├── forge/session.ts   Spec → suite → forge IN PLACE (TsProjectFresh + file sink);
│                      runForgeSessionWith is the scripted-implementor test seam
├── presentation/      eventLines — pure SmithEvent → text (headless lines + feed labels)
├── headless/print.ts  -p mode: live event lines, flush-sentinel printer
└── tui/               the factory floor: theme (single static token set) · presentation/
                       floor (reduceFloor: events → attempt×gate matrix, pure) · state/
                       (signals) · events/pump · commands (:quit/:model/:set via the same
                       SettingsStore) · keys (Esc interrupt · Ctrl-C quit) · view/App.tsx ·
                       runtime (scoped renderer + pump/session fibers + exit Deferred)
```

## Rules

- Same composition discipline the repo gates enforce EVERYWHERE here, with a
  **ZERO-entry ratchet baseline**: any new `let`/loop/nullable-return/tag-switch/
  as-any/try-catch in `packages/smith/src/**` fails `bun run typecheck` outright.
- The implementor is the ONLY place the agent runs; gates never call an LLM
  (the judge-gate seam exists in foundry for that, deliberately unused here).
- A rejected forge run is a RESULT (exit 1 + the report), never an error.
- Launch from the repo root (`bun run smith -- --cwd <target>`): the Solid JSX
  preload lives in the root `bunfig.toml`. The headless path imports no `.tsx`.

## Testing

`bun test packages/smith` — all key-free: settings precedence, briefs,
filesTouched, commandGate (incl. the fail-closed crash fold), suite discovery
over temp dirs, the pure floor reducer, and the **scripted E2E**
(`forge/session.test.ts`: foundry's scripted implementor + a real `bun test`
gate in a temp workspace → fail → feedback → fix → accepted, asserting the
exact `SmithEvent` sequence). Live keyed runs are manual (`-p` on a toy repo).
