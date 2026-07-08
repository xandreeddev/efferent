# @xandreed/smith

**The SPEC-DRIVEN agent in the factory, RE-FOUNDED on the new line.** A rough
idea becomes a **SpecDoc** (drafted by the refiner agent, refined WITH the
human, LOCKED by the human), and only a locked spec forges:
`@xandreed/foundry`'s `forge` loop — implement → snapshot → staged gate
pipeline → typed feedback → retry — with a capable DIRECT coder on
`@xandreed/engine` + `@xandreed/providers` as the implementor: the engine's
loop + the smith coding toolkit (read/write/edit/Bash/grep/glob/ls; writes
cwd-guarded), NO fleet, NO sub-agent tree, NO approval judge — refine is the
prompt engineering, the gates are the judge, nothing in between
(gates-outside doctrine). Conversations persist to the workspace's own
`.efferent/smith.db`. Private, source-run only (`bun run smith`); boundaries:
smith → engine + providers + foundry, never any old-line package.

```bash
bun run smith --cwd ~/code/toy                    # TTY → the PERSISTENT workspace session:
#   dashboard (specs · forge runs · lessons) → type an idea → refine → :lock → :forge
#   (floor live in-session) → :new → next idea. :model [code|fast] pickers · :login/:logout.
bun run smith spec "a stats module with tests" --cwd ~/code/toy   # TTY → refine mode
#   … refine in the composer · :lock approves · :forge builds in the same TUI
bun run smith spec "<idea>" --cwd <dir> -p [--yes]  # one unattended draft on stdout (--yes locks)
bun run smith forge <slug|.efferent/specs/x.md>     # forge a LOCKED spec
bun run smith "<task>" --cwd <dir> [-p]             # shorthand: trivial locked spec + forge
```

The SpecDoc lives at `<cwd>/.efferent/specs/<slug>.md` — git-committable
provenance (flat frontmatter: status/limits/gate overrides; strict sections:
`# Goal`, `## Acceptance`, `## Checks` (`- name: command` — each becomes a
rank-2 `accept-<name>` gate), `## Constraints`, `## Non-goals`). The
`propose_spec` tool is the ONLY way a draft changes; only the human locks.
Exit: 0 accepted/locked · 1 rejected · 2 infra error. Artifact:
`<cwd>/.foundry/runs/<id>.json` (each `AttemptRecord.implementorRef` =
`conversation:<uuid>` — open it in `efferent` via `:browse`).

## Model roles (defaults — all overridable)

general `opencode:kimi-k2.6` (+ `openCodeThinkingMode: "high"`) · code
`opencode:kimi-k2.7-code` · fast `opencode:deepseek-v4-flash`. Configured
**exactly like the efferent CLI**: user `.efferent/config.json`
(local-over-global, `EFFERENT_MODEL`, `~/.efferent/auth.json` via `:login`
there) WINS over these defaults; `--model/--code-model/--fast-model` flags win
over everything (`settings/smithSettings.ts` — the overlay applies on READS
and never persists a smith default). The roles are LIVE: the refiner runs on
GENERAL, the forge implementor runs on CODE (`runForgeSession` scopes the
implementor's LanguageModel through providers' `roleModelView("code")` —
`codeModel ?? model`), and one-shot helpers run on FAST (`UtilityLlm`).

## Layout (boundaries: smith → sdk-core + sdk-adapters + foundry, never cli)

```
src/
├── main.ts            argv fold → SmithCommand (spec | forge <ref> | task shorthand) →
│                      composition root (cli AppLive minus TUI extras + BunContext) →
│                      TTY ? TUI (lazy import) : headless
├── domain/            SmithConfig (defaults + SmithRunConfig) · SmithEvent (the ONE union
│                      both hook families fan into: refine_* + spec_* + forge_* + gate_* +
│                      {type:"agent"})
├── settings/          the SettingsStore overlay (flags > user config > smith defaults)
├── spec/              store (load/write/lock/list + unique slugs over FileSystem) ·
│                      toForgeSpec (SpecDoc → foundry Spec — the ONLY foundry mapping;
│                      gateRequestFromSpec: flags > frontmatter > discovery; trivialSpecDoc
│                      for the shorthand)
├── refine/            session (one persisted conversation with the sdk-core refiner; the
│                      draft FILE is the truth, re-read after every turn; ONE handler
│                      record shared by the real agent layer and the scripted test seam) ·
│                      headless (-p: one unattended draft on stdout, --yes locks)
├── implementor/       efferentImplementor (EfferentImplementorLive: Layer.scoped capturing
│                      the service Context so Implementor stays R=never; ONE conversation
│                      per forge run — retries continue it with the gate brief; receipt.ref
│                      links artifact↔conversation; runFleetToCompletion settles spawns;
│                      only INFRA failures → ImplementorError) · prompt (renderSpecBrief:
│                      acceptance + checks + constraints + non-goals; retry brief)
│                      · filesTouched (tool_call_end → WorkspacePath)
├── gates/             commandGate (rank-2 test gate over Bun.spawn; crash = GateCrash,
│                      fail-closed) · suite (GateSuiteRequest: config | foundry.config.ts |
│                      tsconfig→typecheck + package.json→bun test + spec checks →
│                      accept-<name> gates; zero gates = ConfigError)
├── forge/session.ts   Spec → suite → forge IN PLACE (TsProjectFresh + file sink);
│                      runForgeSessionWith is the scripted-implementor test seam
├── presentation/      eventLines — pure SmithEvent → text (headless lines + feed labels)
├── headless/print.ts  -p mode: live event lines, flush-sentinel printer
└── tui/               THREE modes on one chassis (runtime: withTuiChassis — scoped
                       renderer + pump + exit Deferred; runTui / runTuiRefine /
                       runTuiWorkspace). Workspace = the persistent session: idle
                       dashboard (specs · runs · lessons) ⇄ refine ⇄ forge, exit only
                       by :quit. theme (single token set; no hex/glyph outside it) ·
                       presentation/{floor,refine,workspace,selectBox,promptBox,
                       loginFlow,modelCatalog} (pure machines, fold-tested) · state/
                       (signals + the ONE overlay: select picker | login flow) ·
                       view/ui/{atoms,BottomMenu,PromptBody} (the MenuRow discipline:
                       one row shape for every menu) · actions/{model,login} (drivers;
                       anthropic OAuth = PKCE + loopback server RACING a pasted
                       redirect, state===verifier CSRF) · login/oauthServer · commands
                       (:quit/:new/:lock/:forge [slug]/:model [code|fast]/:login/
                       :logout) · keys (ONE Esc rule: overlay → forge → composer)
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
- **`EFFERENT_MODEL` is IGNORED** (dropped at the edge, with a stderr note):
  Bun auto-loads the LAUNCH dir's `.env`, so the efferent repo's own seed would
  silently override smith's general default for every target workspace
  (live-caught). Pick models via flags or `.efferent/config.json`.

## Testing

`bun test packages/smith` — all key-free: settings precedence, briefs,
filesTouched, commandGate (incl. the fail-closed crash fold), suite discovery
over temp dirs, the pure floor reducer, and the **scripted E2E**
(`forge/session.test.ts`: foundry's scripted implementor + a real `bun test`
gate in a temp workspace → fail → feedback → fix → accepted, asserting the
exact `SmithEvent` sequence). Live keyed runs are manual (`-p` on a toy repo).
