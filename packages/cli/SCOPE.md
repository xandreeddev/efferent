---
name: cli
description: Owns packages/cli/. The efferent CLI driver — composition root for the run modes (TUI, print, json, rpc, daemon) + the per-workspace daemon, the one CLI that runs agents on the runtime. The TUI is OpenTUI + SolidJS (no React/Ink).
---

## Layout
```
src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          AgentEvent union + makeEventHooks(queue, extraBeforeTool?)
├── terminal.ts        OSC-52 + spinner frames + ANSI/width helpers (shared infra)
├── modes/{tui,print,json,rpc,daemon}.ts
├── usecases/          buildScopeRuntime · agentBus · schedule · loadAgents · loadTools …
├── prompts/coder.ts   the root + scope system prompts
├── login/oauthServer.ts   loopback OAuth callback server (:53692) + open-browser
└── cli/               the TUI driver — OpenTUI native renderer + SolidJS (no React)
   ├── runtime.ts      composition root + the Effect⇄Solid⇄OpenTUI three-runtime bridge
   ├── state/          signal slices (conversation · side · session · ui · overlay · theme)
   ├── events/         the Effect→signal event pump
   ├── actions/        signal→Effect use-cases (submit · session · contextTree · search · login …)
   ├── keys/ + commands/   key dispatch + the `:` command surface
   ├── view/           App.tsx + panes/ + panes/side/ + chrome/ + overlays/ + ui/ (token-driven primitives)
   └── presentation/   pure L1 models + the theme/ design system (no Solid/OpenTUI imports)
```

## In-app `:login` (no wizard, no init, no env keys)
- The TUI always boots; credentials are added in-session and live **only** in `~/.efferent/auth.json` (the `AuthStore` port). `presentation/loginFlow.ts` is a **pure state machine** composing `selectBox.ts` (auth-method + provider steps, status-tagged) and `promptBox.ts` (masked API-key / pasted-redirect input); the driver runs the effects on each advance.
- The router resolves the key **per request** from the `AuthStore` (no layer-build capture), so a login takes effect immediately — no restart. The first login also pins that provider's default model.
- OAuth subscription (Anthropic/OpenAI): `login/oauthServer.ts` opens the browser + runs a loopback callback server (races a manual paste of the redirect URL); `adapters/src/auth/oauth/*.ts` holds the PKCE/exchange/refresh protocol.

## The contextual panel (activity · context · agents · sessions)
- The panel fills the message region when focused (`v` cycles its views; `:activity`/`:context`/`:tree`/`:sessions` open one). State + reducers are pure in `presentation/sidePane.ts`; the views render in `view/panes/side/`.
- **activity** — a dashboard: a context-window gauge + cumulative stats, the agent's latest `update_plan` checklist, the run/execution tree (rebuilt from history on every context switch via `presentation/historyProjection.ts`), and pinned workspace sections (files diffstat, skills, instructions).
- **context** — `presentation/contextView.ts`'s viewer: foldable, selectable turns + handoff segments; `Space` picks turns/handoffs and `b`/`:build` forks a new session from the selection.
- **agents** (`:tree`) — workspace conversations + their persisted sub-agent trees (git-graph rails); `↵` switches the active session or previews a node, `c` forks a node into a new session, `d` drops a node.

## Handoff
- **`:handoff`** runs `createHandoff` (core) — summarizes the loaded view, writes a checkpoint, pushes a `checkpoint` block. **`:browse`** lists workspace conversations; **`:resume <#|id>`** switches to one. The fold-point semantics live in `@xandreed/sdk-core`; this package is display + driving only.

## Hard rules
- No domain logic. If something is a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@xandreed/sdk-core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Http | Shell | LanguageModel | ConversationStore | ContextTreeStore | SettingsStore | WebSearch>` (the TUI adds `ModelRegistry` + `LlmInfo`) that subscribes to the event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap providers, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` come from `@effect/cli` — don't shadow them.

## TUI invariants
The TUI is the agy direction — **one borderless message region** (the conversation, or a focus-gated contextual panel in its place) under a one-line header, over the bottom chrome (pending queue · input fence · `:`/`/` contextual menus · status bar). No pane borders, no sidebar column, no floating modals; every contextual surface renders borderless inline via the `Sheet`/`BottomMenu` primitives. The full layout, key map, design-system rules, and bash-safety layering are in **`AGENT.md` → `## TUI invariants`** — the authoritative reference; don't duplicate it here.

## Hardcoded knobs (move to a settings layer later)
- Bash timeout default: 60s.
- TUI palette: 6 visible rows; `:` commands listed in `presentation/slashPalette.ts`.
- `maxSteps` for the agent loop: default 20 (`Settings.maxSteps`).
