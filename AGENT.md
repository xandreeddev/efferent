# efferent — coding agent on Effect.ts + Bun

Coding agent CLI built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack. See `docs/roadmap.md` for what's deferred and `docs/comparison.md` for how we stack up against Claude Code + pi.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain: entities, ports, use cases, prompts — depends on `effect` + `@effect/ai`
├── adapters/     Layer impls of ports — depends on @efferent/core + external SDKs (@effect/ai-google, @effect/ai-openai, Postgres)
└── cli/          coding-agent driver: TUI + print + json + rpc modes
```

**Dependency direction is strictly inward.** `cli` → `adapters` → `core`. `core` imports nothing from siblings. `adapters` imports `@efferent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services in `@efferent/core/ports/`. Each ships its tagged errors next to it.
- **Adapters** provide one `Layer.effect` per port. External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Config via `Config.string` — never hardcode.
- **Use cases** live in `@efferent/core/usecases/` returning `Effect.Effect<A, E, …>`. No IO; the only SDK allowed in `core` is `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`). Provider packages (`@effect/ai-google`, `@effect/ai-openai`) live in `adapters`.
- **Agent configs** (`@efferent/core/usecases/{agentConfig,coderAgentConfig}.ts`) bundle a system prompt + an `@effect/ai` `Toolkit` into an `AgentConfig<Tools>`. `runAgent` is parameterized by config; the CLI picks `coderAgentConfig(cwd)`. The toolkit's handler `Layer` (`codingToolkitLayer(cwd, skills, { allowBash })`) is provided at the driver's composition root — it carries the runtime deps (`cwd`, `FileSystem`, `Shell`).
- **Schema** lives in `effect` itself: `import { Schema } from "effect"`.
- Bun runs `.ts` directly. No build step, no emit. `tsc --noEmit` is purely a typecheck gate.
- File naming: camelCase for files that export functions; PascalCase for files that export types / `Context.Tag` classes.

## Dev commands

```bash
bun install                                          # from agent/ root only
bun run typecheck                                    # cross-package via path mappings
bun run build                                        # bundle the CLI → packages/cli/dist/efferent.js
bun run eval [name …]                                # run eval suites (key-gated)
bun run generate-models                              # refresh the model catalogue from models.dev

# Postgres is OPTIONAL (only when EFFERENT_DB_URL is set); the default store is SQLite.
docker compose up -d                                 # start local Postgres (host port 5434)
docker compose down                                  # stop it
docker compose exec postgres psql -U agent -d agent  # poke at the DB

efferent                                                # full TUI (TTY default; :login to add a provider)
efferent "<prompt>"                                     # one-shot print mode
efferent -p / --print                                   # explicit print mode (stdin OK with "-")
efferent --mode json "<prompt>"                         # stream events as JSONL on stdout
efferent --mode rpc                                     # bidirectional JSON-RPC on stdin/stdout
efferent --resume <conversationId>                      # resume an existing session
efferent --allow-bash                                   # allow bash in non-interactive modes
efferent --cwd <path>                                   # override workspace (defaults to process.cwd())
```

Credentials & setup. **Credentials come *only* from `~/.efferent/auth.json`, written by the in-app `:login` flow — there is no env-var key reading and no `init` command.** `efferent` always boots straight into the TUI; with no credential it shows `No models available. Run :login …` and sending a message short-circuits to the same hint. **`:login`** is a pi-style flow (`packages/cli/src/tui-solid/presentation/loginFlow.ts` + `promptBox.ts`, composited like the `:model` picker): pick *Use a subscription* (OAuth) or *Use an API key* → pick a provider (status-tagged ✓api key / ✓subscription / •unconfigured) → paste a masked key **or** run the OAuth flow → persisted to `auth.json` → **usable that turn, no restart**. **`:logout <provider>`** removes a credential. The first successful login also pins that provider's default model. Non-interactive modes (print/json/rpc) can't run `:login`, so they require a credential already in `auth.json` (else they exit with a hint).
- **`AuthStore`** port (`@efferent/core/ports/AuthStore.ts`) + `LocalAuthStoreLive` (`adapters/src/auth/local.ts`): a `Ref` seeded from `auth.json` (per-provider `{ type: "api_key" } | { type: "oauth", access, refresh, expires }`; legacy flat-string entries read as api keys), atomic `0600` writes. `resolveKey` is read lazily per request by the router/registry, refreshing a near-expiry OAuth token first. Reads no env; `EFFERENT_HOME` only relocates the config dir (default `~/.efferent`). The router builds the provider client per turn from `resolveKey`, so a login mid-session takes effect immediately. Evals/CI use `EnvAuthStoreLive` (`adapters/src/auth/env.ts`) — the *only* place provider key env vars are read.
- `EFFERENT_DB_URL` — **optional.** Selects the conversation store: `postgres://…` → Postgres; any other value → SQLite at that path (optionally `sqlite:`-prefixed); unset → zero-config **SQLite** at `~/.efferent/efferent.db` (the default; no Docker). May also live as `dbUrl` in `~/.efferent/config.json`; the env var **overrides** the config value (seeded into the env at boot by `seedDbUrlFromConfig`, since the store is chosen at layer-build before settings load). Parsed by `parseDbTarget` and selected in `adapters/src/database/migrator.ts` (`ConversationStoreLive`); migrations load via `Migrator.fromRecord` (bundle-safe).
- Optional `EFFERENT_MODEL` — seeds the active model when no `config.json` pins one. Accepts `"<provider>:<modelId>"` (e.g. `openai:gpt-4o`) or a bare id (provider inferred; defaults to Google). Default `google:gemini-3.5-flash`. An explicit `/model` switch is persisted to `.efferent/config.json` and wins over `EFFERENT_MODEL`.

## Install / distribution

Published as the unscoped npm package **`efferent`** (bin `efferent` / `eff`), a Bun bundle (`bun run build` → `packages/cli/dist/efferent.js`, core + adapters + `@effect/*` + `@opentui/solid` + `solid-js` inlined, `#!/usr/bin/env bun`). Requires **Bun** at runtime and has **two runtime dependencies: `@opentui/core`** (+ its platform-native `@opentui/core-<platform>` subpackage) — the TUI's native Zig renderer is `dlopen`'d via FFI and can't be inlined, so it stays external; it *also* ships the tree-sitter grammar WASM (`assets/{javascript,typescript,markdown,zig}`) + the `parser.worker.js`, both resolved from its own install dir — **and `web-tree-sitter`** (the highlighter that worker imports; a peer dep of `@opentui/core`, so we declare it directly or `npm i -g` won't install it). Everything else is inlined; the workspace + the other `@effect/*` are devDependencies. `npm i -g efferent` then just run `efferent` — it boots into the TUI and you add a provider in-session with **`:login`** (subscription/OAuth or API key); no wizard, no `init`, no env vars. Works in any project with no Docker (SQLite history + `auth.json` under `~/.efferent/`). Do not publish without explicit sign-off (outward-facing).

## Coding tools (CLI)

An `@effect/ai` `Toolkit` in `@efferent/core/usecases/codingToolkit.ts`, backed by the `FileSystem` and `Shell` ports. Each tool is a `Tool.make` def with an **object** `success` Struct + a shared `failure` Struct and `failureMode: "return"` (so a tool failure is returned to the model as data, not thrown). Handlers live in `codingToolkitLayer(cwd, skills, { allowBash })`, which resolves `FileSystem`/`Shell` from context at layer-build time. (Gemini rules learned the hard way: every tool needs ≥1 parameter, and `success` must be an object — see the spike notes in the plan.)

| tool         | parameters                                       | implementation                              |
|--------------|--------------------------------------------------|---------------------------------------------|
| `read_file`  | `{ path; offset?; limit? }`                      | `FileSystem.read`                            |
| `write_file` | `{ path; content }`                              | `FileSystem.write`                           |
| `edit_file`  | `{ path; edits: [{ oldText; newText }] }` *or* flat `{ path; oldText; newText }` | `normalizeEdits` → read → string replace → write, returns diff |
| `Bash`       | `{ command; timeout? }`                          | `Shell.exec`, cwd bound at tool-build time  |
| `grep`       | `{ pattern; dir?; flags?; context? }`            | shells out to `grep -rnE` for now            |
| `glob`       | `{ pattern; dir? }`                              | `FileSystem.glob` via `Bun.Glob`             |
| `ls`         | `{ path?; recursive? }`                          | `FileSystem.list`                            |
| `web_fetch`  | `{ url; maxBytes? }`                             | `Http.get`; HTML reduced to text             |
| `search_web` | `{ query }`                                      | `WebSearch.search` → `{ answer; sources }`   |

All paths resolved relative to the `cwd` bound in `codingToolkitLayer(cwd)`. **`edit_file` accepts two shapes:** the canonical `edits: [{ oldText, newText }]` array, or a flat single-edit `{ oldText, newText }` at the top level — the shape models trained on Claude Code's `Edit` tool emit when there's only one edit. Both are normalised by `normalizeEdits` *inside* the handler. This matters because `@effect/ai` decodes tool-call parameters **before** the handler runs (`Toolkit.handle`), so a shape mismatch is an `AiError.MalformedOutput` that `failureMode: "return"` can't catch — it aborts the whole turn. Keeping the parameter schema permissive enough to decode both shapes, then validating in the handler, turns "wrong shape" into a graceful, model-visible `EditFailed` instead of a dead turn. **Names matter:** Anthropic reserves the lowercase tool names `bash` / `web_search` / `computer` for its provider-defined tools (case-sensitive lookup); when we register a handler-backed tool by one of those names, the Anthropic SDK reroutes it to the built-in provider tool — which isn't in our toolkit, so the turn fails. So our shell is **`Bash`** (capital B) and our search is **`search_web`** (reversed). `search_web` is provider-native (see below) — it has no parameter-less constraint issue because `{ query }` satisfies the ≥1-parameter rule.

## Web search

Provider-native, no extra key. The `web_search` tool is backed by the `WebSearch` port (`@efferent/core/ports/WebSearch.ts`) and `WebSearchLive` (`adapters/src/llm/webSearch.ts`). Each call is a **dedicated, grounding-only** `generateText` against a provider's *server-side* search tool — Gemini `GoogleTool.GoogleSearch` or OpenAI `OpenAiTool.WebSearch` (`Tool.ProviderDefined`, handler-free). It returns `{ answer, sources }` (sources from the response's `UrlSourcePart`s). The model finds with `web_search`, then reads a chosen source with `web_fetch`.

**Deliberately a separate thing** (not merged into the agent's main toolkit): the search call carries *only* the search tool, never the agent's function tools — so it needs no extra credential beyond a logged-in provider, and sidesteps providers (notably Gemini) that won't combine grounding with function calling in one request. It's also decoupled from the chat `/model`: configured via `EFFERENT_SEARCH_MODEL` (`<provider>:<modelId>`), else defaults to whichever of Google/OpenAI is logged in (Google preferred). `WebSearchLive` resolves its key per call from the `AuthStore` and builds its own client over a `FetchHttpClient`. Gemini's grounding source URLs are `vertexaisearch…` redirects — `web_fetch` follows them.

## Agent loop

One use case — **`runAgent(config, conversationId, prompt, hooks?)`** in `@efferent/core/usecases/runAgent.ts` — drives the whole interaction. The loop lives in `@efferent/core/usecases/agentLoop.ts`. **`@effect/ai` resolves a single model step's tool calls (its handlers are our Effects) but does NOT iterate across turns — so iteration is ours**: each turn maps the message buffer to a `Prompt`, calls `LanguageModel.generateText({ prompt, toolkit })`, appends the response parts as the new tail, and re-invokes until `finishReason !== "tool-calls"` or `maxSteps`.

```
efferent <prompt>
  ↓
runAgent(coderAgentConfig(cwd), conversationId, prompt, hooks)
  ├── ConversationStore.append(user) ; list → message history
  ├── runAgentLoop({ system, messages, toolkit, hooks, maxSteps })
  │     ├── turn 0..N: onTransformContext? → onTurnStart
  │     │              → Prompt.make([system, ...toPromptMessages(messages)])
  │     │              → LanguageModel.generateText({ prompt, toolkit })   (resolves this step's tools)
  │     │              → responseToAgentMessages(res.content) onto buffer  (carries thought_signature in providerOptions)
  │     │              → re-emit onBeforeToolCall / onAfterToolCall / onAssistantMessage(TokenUsage) from the response
  │     │              → continue iff finishReason === "tool-calls" && toolCalls > 0 ; onShouldStopAfterTurn?
  │     └── while turnIndex < maxSteps
  ├── ConversationStore.append(tail)
  └── return AgentResult { finalText, messages }
```

**Prompt mapping** (`@efferent/core/usecases/promptMapping.ts`): bridges our persisted `AgentMessage` (Vercel-shaped, unchanged) with `@effect/ai`'s `Prompt`/`Response`. The opaque provider blob is carried verbatim both ways (`providerOptions ↔ options`/`metadata`), which is how Gemini's `thought_signature` round-trips across our turns — `Prompt.fromResponseParts` drops it, so we map by hand.

**Hooks** (`@efferent/core/AgentHooks`): the loop re-emits the legacy event vocabulary (`onTurnStart` / tool events / `onAssistantMessage`) from each resolved response, so the CLI's `makeEventHooks(queue)` (`packages/cli/src/events.ts`) and the TUI execution tree keep working unchanged.

**Graceful tool errors**: each tool's `failureMode: "return"` + `failure` Struct means a handler failure (e.g. `FileNotFound`, ambiguous edit) is returned to the model as a tool result instead of aborting the turn. **But `failureMode` only catches *handler* failures** — `@effect/ai` decodes a tool call's parameters (and resolves the tool name) *inside* `Toolkit.handle`, **before** the handler runs, so a wrong-shaped call or a hallucinated tool name fails with `AiError.MalformedOutput`, which `failureMode` never sees and which aborts the whole turn. `recoverMalformedToolCalls` (`agentLoop.ts`) closes that gap: it resolves the toolkit's handler once and wraps it so a `MalformedOutput` is converted into an ordinary tool *result* (`isFailure: true`, `error: "InvalidToolCall"`). The assistant tool-call ↔ tool-result pairing stays valid, the loop proceeds to its next turn, and the model reads the decode error from context and emits a corrected call — the **same** recovery path as any returned failure, no retry machinery. (`MalformedInput` — a result encode/validate failure, i.e. *our* bug — is deliberately let through, not masked.)

**Bash safety**: gated in the `bash` handler via the `allowBash` flag on `codingToolkitLayer` (denied → returned as a tool failure). Non-interactive modes pass `--allow-bash`; the TUI currently allows bash (interactive per-command confirm is a deferred follow-up).

## Handoff & conversation context

A **handoff** replaces the *loaded* history with a model-generated summary while keeping the originals. It's how a long session frees context without losing the record.

- **Storage** (`checkpoints` table, migration `0005`): a checkpoint is `{ messagePosition, summary }` for a conversation. Original `messages` rows are never modified. `ConversationStore` exposes `checkpoint(id, summary)` (atomic — folds at `COALESCE(MAX(position), -1)` in one statement), `getLatestCheckpoint`, `listCheckpoints`, `list` (ALL messages, for browsing), and `listActive` (only real rows **after** the latest fold).
- **Loading** (`runAgent`): loads `getLatestCheckpoint` + `listActive`, prepending the summary as a single synthetic `user` message via `handoffToMessage` (`promptMapping.ts`) — domain logic stays in core, not the adapter. So the model sees `[handoff summary] + [messages since the fold] + [new user msg]`; everything before the fold is preserved but never re-fed.
- **Creating** (`createHandoff`, `@efferent/core/usecases/handoff.ts`): summarizes the **currently loaded view** (prior summary + active window, never the raw `list`) with `HANDOFF_PROMPT` (`prompts/handoff.ts`, a Goal/State/Next-steps/Constraints brief) and writes a checkpoint. Summarizing the loaded view keeps handoffs **cumulative** — a second handoff folds the first summary back in. No-op when nothing new since the last fold.
- **TUI**: `:handoff` runs it (pushes a checkpoint block); `:context` toggles the **context viewer** in the side pane (`tui-solid/presentation/contextView.ts` — `buildContextView` partitions `list` + `listCheckpoints` into *archived* segments (folded, not loaded) and the *loaded* segment; `buildContextRows` groups each segment's messages into **foldable, selectable turns**, rendered as a tree so the replacement is visible); `:browse` lists workspace conversations and `:resume <#|id>` switches to one (full replay for browsing, active-window for execution). On boot with no `--resume`, if the workspace has prior conversations, a **startup picker** (`openConversationPicker` → a select overlay, purpose `conversation`) floats "Resume a conversation" over the fresh session — a leading "＋ Start a new conversation" row then `<date> · <first-prompt>` per conversation; Enter resumes via `resumeConversation`, Esc / "start new" leaves the fresh session. No prior conversations → straight to an empty rail.
- **Curate context → new session**: in the context viewer, `Space` selects/deselects a **turn** *or* a **handoff** (the `⚑` archived-segment header) and `b` (or `:build`) **builds a new conversation** seeded with only the picked units, switching to it (`messagesForSelectedTurns` → `ConversationStore.create`/`append` → the `:resume` switch). A selected handoff contributes **only its summary, as one `handoffToMessage` message** (not the folded originals); a handoff and its own inner turns are therefore **mutually exclusive** (selecting one clears the other — `archivedTurnRanges`/`handoffOwningTurn` in `contextView.ts`). Turn granularity keeps tool-call/result pairs valid; the original conversation is untouched.

## CLI shape

Composition root: `packages/cli/src/main.ts`. Four modes under `packages/cli/src/modes/`:

- **`tui.ts`** — now just the `TuiModeInput` seam; the driver lives in **`packages/cli/src/tui-solid/`** (OpenTUI native renderer + **SolidJS** signals, **no React**), loaded by `main.ts` via a lazy dynamic `import()` so `@opentui/core`'s native FFI lib is touched only on the TUI path. Default in a TTY. **Modal, multi-pane**, Neogit-flavoured layout: **two bordered boxes** (`┌─ conversation ─┐ ┌─ activity ─┐`) with **one empty column between them** (OpenTUI/Yoga flex, not hand-drawn); each pane has a **distinct accent** when focused (conversation cyan / side magenta / input green — `tokens.accent`/`paneBorder` in `presentation/theme/`, applied via the `<Pane>` primitive). A **bordered keybind box** (`view/chrome/Keybinds.tsx`) sits below — its border + title take the *focused* pane's accent and the title carries `<pane> · <MODE>` (the status bar is `model · tokens · storage · cwd`); its body is **two labelled rows** — a dim global `nav` row over a dynamic row of the focused pane's real keys. Plus a multi-line **`<textarea>`** input (Enter inserts a newline · **Shift-Enter** sends, Alt-Enter too · grows 1→8 rows; in `:`/`​/` mode **Enter runs** the command/search outright and **⇥/→** completes the highlighted palette entry; **↑/↓** recall sent-message history on a single-line message, or move the palette highlight in command mode — `dispatch.ts:inputKey` claims these *before* the textarea via `KeyEvent.preventDefault`), a `/` search status line, a dim footer, a `:` command palette (`:exit`, `:clear`, `:help`, `:cwd`, `:reset`, `:handoff`, `:context`, `:build`, `:browse`, `:resume`, `:settings`, `:set`, `:model`, `:effort`, `:search`, `:theme`, `:login`, `:logout`, `:db`), and `/` per-pane search (the focused read-only pane — conversation or side). Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l or Ctrl-arrows**; the input is INSERT, the read-only panes NORMAL with a **vim-style fold cursor** (a shared `presentation/paneNav.ts` flattens each pane to navigable rows; `{`/`}` step paragraphs, `[`/`]` jump messages/heads, `gg`/`G` ends, `⇥`/`↵`/`h`/`l`·←/→ fold the unit under the cursor — **charwise motions `w/b/e` + VISUAL remain deferred**, see roadmap). Conversation pane: `j/k`·↑↓ **scroll lines** + `Ctrl-D/U`·PgUp/PgDn page (a registered `ConvScroller`), while the fold cursor (`{}`/`[]`/`gg`/`G`) tints the current unit + scrolls it in; `Z` fold-all; `/` search (jump-to-match + `[i/N]` + n/N + Esc); and **`y`** yanks the OpenTUI mouse selection via OSC 52 (drag-select is native — `useMouse:true`). The conversation is a Claude-style **event rail**: assistant prose (rendered as **markdown** via OpenTUI's native `<markdown>` — headings/bold/italic/inline-code/lists/links styled, markers concealed; the `●` floats over the top-left via `position:absolute` so the markdown stretches + wraps with a 2-space hanging indent) and each tool lead with a `●` (colour carries run/ok/error), tool headers read `ToolName(arg)`, results hang under a `⎿` connector (`edit_file` diffs render through the native `<diff>` — `+/-` line colouring + line numbers, parsing the canonical unified diff core emits). Fenced **code blocks** and diff **hunks** are **syntax-highlighted** via tree-sitter (`view/syntax.ts` — one combined `SyntaxStyle` carrying both the markdown `markup.*` scopes *and* code capture scopes (`keyword`/`string`/…); the shared `getTreeSitterClient()` singleton + a per-diff `filetype` from its `+++` header; grammars cover **JS/TS/markdown/zig**, others render un-highlighted; the worker is **best-effort** and `runtime.ts` destroys it on exit so Bun can quit). Foldable **turns** ("commits", `▾`/`▸` collapsing to `▸ <subject> · N steps`). A run of ≥2 tool calls in a turn **aggregates into one collapsed-by-default summary line** — `▸ read · grep · edit  (3 tools, +5 -2)` (verbs with consecutive repeats as `read ×3`, the call count, the rolled-up edit diffstat, plus any running/failed counts; the caret coloured by the group's aggregate state so a failure shows through the fold) — `⇥`/`↵` expands it to the individual pills. Group fold uses **inverse polarity** to a turn: membership in the `collapsed` set ⇒ *expanded* (`toolGroupSummary`/`toolGroupState` in `conversation.ts`; `Z` honours both defaults via `foldIdsByKind`). Every rail block (prose · pill · group · info) is separated by a **blank line** (`marginTop:1` per body item) so the pane breathes. The default side view is **activity** — a dashboard (context gauge, cumulative output/turns/elapsed, per-LLM-call usage + duration, files-changed diffstat, foldable skills/instructions); navigable with its own **block cursor** (`j/k`·`{}` step rows, `[]` jump heads, `gg/G` ends, `Tab`/`Enter`/`h`/`l`·←/→ fold a section **or** a turn/sub-agent node; `/` searches the rows) and **collapses the previous run when a new user message starts a run**. The **context viewer** (`:context`) is a navigable tree of foldable, selectable **turns and handoffs**: `j/k`·`{}`/`[]` move, `Tab`/`h`/`l`·←/→ fold, `Enter` jumps the conversation, `Space` selects, `b`/`:build` builds a new session from the selection, `/` searches. **Ctrl-C** is 2×-to-quit. Structure under `packages/cli/src/tui-solid/`: `runtime.ts` (composition root + the three-runtime bridge), `state/` (signal slices), `events/` (Effect→signal pump), `actions/` (signal→Effect), `keys/` + `commands/`, `view/` (`panes/`, `panes/side/`, `chrome/`, `overlays/`, and `ui/` — the token-driven primitives `Pane`/`Modal`/`Rule`/`Cursor`/`Marker`/`RailLine`/`SectionHead`, the only components that paint borders/surfaces/glyphs), and `presentation/` — the **pure L1** model/state layer (`theme/` (the two-tier **design system**: `palette` → semantic `tokens` + `glyph` + `themes`; a theme is one complete set of token values; **`presentation/theme/` is pure + static**, while `state/theme.ts` wraps the active theme in a process-global Solid signal exposing a **Proxy-backed reactive `tokens`** every view reads, so **`:theme`** switches live with no call-site change — ships `one-dark` + `tokyo-night`, the choice persisted to `config.json` (`Settings.theme`) + seeded at boot; `view/syntax.ts` memoises its `SyntaxStyle` per theme name so code highlighting follows the switch; **no raw hex/glyph literal lives outside `theme/`**), `conversation` (rail block/turn/fold model), `contextView`, `sidePane`, `selectBox`, `promptBox`, `loginFlow`, `settingsView`, `slashPalette`, `statusBar`, `executionTree`, `toolDescribe`, `dbStatus`, `logger`); no Solid/OpenTUI imports. (This was the old sibling `tui/` folder + `model/conversation.ts`, renamed so the tree no longer reads as two TUIs.) `terminal` (OSC/spinner/ANSI consts) is shared infra at `src/terminal.ts` — a non-TUI mode imports it.
- **`print.ts`** — one-shot. Prompt from argv or stdin (`-`). Final text on stdout, tool log on stderr. Exits when done.
- **`json.ts`** — same control flow as print, but every `AgentEvent` is JSONL on stdout.
- **`rpc.ts`** — bidirectional JSON-RPC on stdin/stdout. Method: `agent.send({ prompt, conversationId? })` → emits `agent.event` notifications, resolves with `{ conversationId, finalText }`.

Modes share one `AgentEvent` union (`packages/cli/src/events.ts`); the loop's hooks push events onto a queue; each mode renders differently.

## Models & providers (multi-provider router)

The agent loop talks to one provider-agnostic `LanguageModel`; which provider/model backs it is a **runtime selection**, not a compile-time layer choice.

- **Router** (`adapters/src/llm/router.ts`, `RouterLanguageModelLive`): a `LanguageModel` whose `generateText`/`streamText`/`generateObject` read `ModelRegistry.current` on every call, resolve a key from the `AuthStore` (refreshing an expired OAuth token first), and build the chosen provider's `@effect/ai` service **per request** from that key over a shared `FetchHttpClient` (`Effect.scoped`/`unwrapScoped` so the client lives exactly one call). So a credential added mid-session via `:login`, or a `/model` switch, takes effect on the next turn with no rebuild. There is no longer a `clients.ts` — keys aren't captured at layer-build.
- **Anthropic OAuth** (subscription): when the credential is `oauth`, the client is built with `apiKey: undefined` + a `transformClient` that sends `Authorization: Bearer …` and `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (no `x-api-key`), and the router prepends the required `"You are Claude Code, Anthropic's official CLI for Claude."` system block (`Prompt.merge`). Protocol + constants in `adapters/src/auth/oauth/anthropic.ts` (PKCE, authorize URL, exchange, refresh); callback server + browser-open in `cli/src/login/oauthServer.ts`.
- **Selection** lives in `SettingsStore` as `settings.model = "<provider>:<modelId>"` (the single source of truth, persisted to `.efferent/config.json`). `parseModel`/`formatModel`/`contextWindowFor`/`defaultModelForProvider(s)` are pure helpers in `@efferent/core/entities/Model.ts`.
- **`ModelRegistry`** port (`@efferent/core/ports/ModelRegistry.ts`): `current` (parsed selection), `list` (live catalogue), `select` (persist + return). `ModelRegistryLive` (`adapters/src/llm/modelRegistry.ts`) fetches the catalogue over **raw HTTP** (Google `…/v1beta/models`, OpenAI `…/v1/models`, Anthropic `…/v1/models`) and parses defensively; keys come from the `AuthStore`, so only logged-in providers are queried (Anthropic OAuth uses a Bearer header).
- **`ModelLive`** bundles router + `ModelRegistry` + dynamic `LlmInfo` over an internal `FetchHttpClient`; requires `SettingsStore` + `AuthStore`. Replaces the old single-provider `GoogleLive`.

**`/model`** (TUI): no arg lists the live catalogue numbered + caches it; `/model <#|id>` switches, persists, updates the status bar. Switching provider mid-conversation applies going forward and surfaces a one-line hint (Gemini 400s on prior non-Gemini tool-calls that lack a `thought_signature` — `/reset` if it errors).

**Caching** is aggressive but provider-native: OpenAI gets automatic prompt-prefix caching + a stable `prompt_cache_key`; Gemini relies on implicit context caching (stable prefix → `cachedContentTokenCount`). Explicit Gemini `cachedContent` is not expressible through `@effect/ai-google` today (it always sends full `contents`), so we don't fake it.

## Token & model display

`LlmInfo.metadata` (provided by `ModelLive`, following the live `ModelRegistry.current`) exposes `{ modelId, contextWindow }`; the TUI status bar reads it at startup and `/model` updates it on switch. After each turn, `onAssistantMessage` carries a `TokenUsage` (input / output / total / cacheRead) for the gauge; `cacheReadTokens` comes from Gemini's `usageMetadata.cachedContentTokenCount`. Cache-read tokens shown dim: `18k (12k cached) / 1M`.

**Context window** comes from `contextWindowFor(provider, modelId)` (`entities/Model.ts`), which reads a **generated catalogue** (`entities/modelCatalog.generated.ts`, snapshotted from [models.dev](https://models.dev) by `bun run generate-models` → `scripts/generateModelCatalog.ts`) — neither Anthropic's nor OpenAI's `/models` API reports a context length, so the catalogue is the source of truth (e.g. Sonnet 4.6 / Opus 4.6+ = 1M). A bare per-provider substring heuristic remains as the fallback for ids newer than the last snapshot; dated ids (`…-20260101`) fall back to their base id. Google's live `inputTokenLimit` still wins when present.

## Skills

`.efferent/skills/*.md` files are auto-discovered at startup. The search path walks `cwd → parents → ~/.efferent/skills/`; closer-to-cwd shadows farther on name collisions. Each skill file has YAML-ish frontmatter and a free-form markdown body:

```
---
name: <slug>
description: <one-line summary for the prompt>
---

(detailed procedure for the agent to follow)
```

At startup, names + descriptions are injected into the coder system prompt under a `# Skills` section. The bodies are lazy-loaded by the model via `read_skill({ name })` only when relevant. Pi-pattern; lets you ship reusable procedures without changing the code.

Loader: `loadSkills(cwd, homeDir)` in `@efferent/core/usecases/loadSkills.ts`. Failures (missing dirs, malformed frontmatter) are silently skipped — a broken skill never breaks the agent.

## Evals

A fourth package, **`packages/evals`** — a minimal, Effect-native eval library (Evalite's `data → task → scorers` shape re-expressed as Effects, so a `task` can be the real agent loop and a `Scorer` can itself call an LLM). Built when Evalite hit three hard incompatibilities at once (native `better-sqlite3` on Node 26, Vercel-AI-SDK coupling, Node-vs-Bun adapter APIs) — the "Evalite until it actively hurts" clause firing. No sqlite, no UI, no persistence; runs under Bun directly.

- **Framework** (`src/framework/`): `EvalSpec<I,O,T,R>` is pure data (`defineEval`); `runEval(spec)` returns `Effect<EvalReport, never, R>` — every per-case/per-scorer failure is captured via `Effect.exit` (so a provider 429 scores 0, never crashes the run) and `R` is left open for the caller to provide once. Scorers (`scorers.ts`): `predicate`, `includesAll` (substring-coverage ratio), `fromEffect`, and `llmJudge` (LLM-as-judge, parses `{"score","reason"}`). `report.ts` prints a coloured per-suite table.
- **Env** (`src/env.ts`): `EvalEnvLive` mirrors `main.ts`'s composition but swaps Postgres for an in-memory `ConversationStore` (`support/inMemoryConversationStore.ts`, replicating the position/checkpoint fold semantics) so evals need no Docker. `support/workspace.ts` gives `withTempWorkspace` (acquire/release temp dirs); `support/coder.ts` (`runCoder`) stands up a real coder agent over a temp repo and reports the tools it called + final text + read-back files.
- **Suites** (`src/suites/*.eval.ts`): `handoff` (seed a transcript → `createHandoff` → judge the summary), `tool-selection` (read-only intent, bounded to the first tool turn via an allow-list + `onShouldStopAfterTurn`, assert the first tool), `coder-edit` (full loop edits a temp file → read it back → assert + judge).
- **Run**: `bun run eval [name …] [--json]` (`src/run.ts`). Gated on `hasKey(GOOGLE_API_KEY|OPENAI_API_KEY)` — no key → suites skip cleanly. Unit tests (`bun test`) cover the framework (incl. captured failures) and the in-memory store fold contract, with no LLM.

## Deferred (do not build until they hurt)

See `docs/roadmap.md` for the full backlog. Highlights of what's NOT yet built:

- **Explicit Gemini context caching** — implicit caching is live (see Models & providers). Explicit `cachedContent` resources would need `@effect/ai-google` to let us send a trimmed `contents` + suppress system/tools; it can't today, so deferred. Cost optimisation, not correctness.
- **Interactive TUI bash confirm** — bash is gated by the `allowBash` flag in the handler (the TUI passes it `true`); a per-command approval modal in the OpenTUI overlay layer, consulted from `onBeforeToolCall`, is not yet wired (the old `promptForBash` stub was removed with the hand-rolled driver at cutover).
- **Live token streaming** — the loop uses `generateText` per turn; switch to `streamText` and map stream parts to events for token-level TUI updates.
- **Per-conversation OpenAI `prompt_cache_key`** — currently a stable static key; threading the conversation id would tighten cache routing.

- **Settings UI / config files** — a few knobs still hardcoded in `main.ts` composition (`/model` + `/set` cover model + the core settings).
- **Auto-compaction** — manual `:handoff` ships (see Handoff & conversation context). Automatic, token-threshold folding via `onTransformContext` (the hook is wired but unused) is the remaining piece; needs the loop's tail-persistence to be robust to a shrinking buffer first.
- **Streaming tool output** — bash stdout chunks back to the model live.
- **Branch / fork / session tree**; **extension system**; **parallel tool execution**.
- **Image attachments** in the CLI; **native (non-shell-out) grep**.
- **Charwise vim motions + VISUAL in the TUI** — the read-only panes now ship a **fold cursor** (a row-granular cursor over the shared `presentation/paneNav.ts` rows: `{}`/`[]`/`gg`/`G` move, `⇥`/`↵`/`h`/`l` fold the unit under it) **and per-pane `/` search**. What's still deferred is a **charwise per-line cursor** + NORMAL/VISUAL motions (`w/b/e`, `0/^/$`, charwise/linewise VISUAL) layered on the panes + the `<textarea>` (reuse the pure `viMode` logic deleted with the old driver — recover from git history). Related deferred TUI bits: **wider code-highlight language coverage** (markdown prose + fenced-block + diff-hunk syntax highlighting all ship via tree-sitter, but `@opentui/core` only bundles **JS/TS/markdown/zig** grammars — python/rust/go/json/bash/etc. render un-highlighted until we `addFiletypeParser` more grammar WASM + queries; also still unstyled: `#` heading *colour*, since marked headings route around the `markup.heading` scope which only styles table headers), **simultaneous match highlight for side-pane search** (the cursor + `[i/N]` counter mark the current hit; other matches aren't tinted), **prompt-history recall** on ↑/↓ (collides with the textarea's line navigation — intercept at the first/last line), **Ctrl-R tool-output expand**, the **Shift-Tab effort shortcut**, and **per-tool detail folding** (turn + tool-group folding is per-section today).
- **Evals**: the `packages/evals` harness ships (see Evals). Deferred *within* it: result persistence / trend tracking across runs, an `onAfterToolCall`-driven trajectory scorer, dataset files (cases are inline today), CI wiring. Telemetry + structured logging beyond what `Effect.log` already prints.

## OPSEC reminder

Every commit under this tree must be authored as `Xand Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot. Never commit anything from `~/Workspace/xandreed/pi` — it's read-only research material.
