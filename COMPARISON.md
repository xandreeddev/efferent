# Feature comparison: `xandreed/agent` vs. Claude Code (claw-code)

_Last updated: 2026-05-29._

## Context

We have a lean coding-agent CLI (this repo — Effect.ts + Bun, ports/adapters, on `@effect/ai` with a multi-provider router). It *felt* like it was missing a lot next to mature agents; several of those gaps have since closed (tool showcasing, diffs, web fetch, **web search**), leaving the genuine ones — streaming, extensibility, compaction, memory references. This is an in-depth, area-by-area comparison **so we understand the difference**, plus a prioritized build roadmap.

**Framing:** the goal is understanding, **not parity**. The xandreed wedge is *Effect services + colocated evals + harness-inside-codebase*, lean and no-React. Several Claude-Code features are deliberately **out of scope** — the roadmap marks what's on-thesis to build vs. what to consciously skip.

**Baselines:**
- **claw-code** (`~/Workspace/claw-code`) — a from-scratch port of the *leaked Claude Code* harness. Its Python `src/` is mostly a **catalogue** (JSON snapshots + placeholders in `src/reference_data/`: ~184 tools, 207 commands, 30+ subsystems) with a Rust port underway; `PARITY.md` is the gap index. Read it as **"the full Claude Code feature surface,"** not a working impl — that surface is our reference for "what a complete agent has."
- **pi** (`~/Workspace/xandreed/pi`, `@earendil-works/pi-*`) — the **closest peer**: a TS agent-harness monorepo (`agent` runtime + `ai` multi-provider + `coding-agent` CLI + `tui`), same weight class as us, built **without Effect** (plain erasable TS + typebox + native SDKs). Best benchmark for presentation/UX; see the dedicated section + Appendix D below. (Our `AgentEventSink`/scheduler patterns already borrow from it.)
- **Effect stack** — what `@effect/ai@0.35` + `-google@0.14` + `-openai@0.39` already give us (governs effort).

---

## Feature comparison (all areas)

Status legend — Ours: ✅ have · 🟡 partial · ❌ absent. Verdict: **BUILD** (on-thesis) · **MAYBE** (later) · **SKIP** (not worth it for a lean agent).

| Capability | Ours | pi | Claude Code | On Effect / effort | Verdict |
|---|---|---|---|---|---|
| **Tool-call showcasing** | ✅ pills + tree; **Ctrl-R** expands full output | ✅ collapsible, live partial, per-tool render | ✅ per-tool React UI, collapsible | annotations + render work. **Low** | ✅ **DONE** |
| **Diffs** | ✅ colorized unified diff rendered inline | ✅ rendered + word-level highlight | ✅ syntax-highlighted unified diff | diff in result → render (ANSI). **Low** | ✅ **DONE** |
| **Streaming (token-level)** | ❌ `generateText` one-shot | ✅ built-in (`packages/ai`) | ✅ token + tool-arg deltas | `streamText`→`Stream<StreamPart>`. **Low-med** | **BUILD** (next) |
| **Web search / grounding** | ✅ `web_search` — dedicated grounding-only call (own `WebSearch` port) | ❌ (provider-side only) | ✅ `WebSearchTool` | provider-native `GoogleSearch`/`WebSearch`, no extra key, decoupled from chat model. **Low-med** | ✅ **DONE** |
| **Web fetch** | ✅ `web_fetch` (Http port) | ❌ | ✅ `WebFetchTool` | `Tool.make` over `HttpClient`. **Low** | ✅ **DONE** |
| **Code execution (sandbox)** | ❌ (bash only) | ❌ (bash only) | ✅ `CodeInterpreter` | provider `CodeInterpreter`/`CodeExecution`. **Low** | **MAYBE** |
| **Compaction** | 🟡 hook wired, no impl | ✅ branch summarization + `/compact` | ✅ auto + microcompaction | `Tokenizer` + summarize in hook. **Med** | **BUILD** |
| **Token budget** | 🟡 gauge only | ✅ drives compaction | ✅ budget-driven | gauge + `Tokenizer`. **Low** | **BUILD** |
| **Sub-agent delegation** | ❌ dropped in migration | ❌ (single-agent) | ✅ AgentTool/Task/Team | nested `runAgentLoop` as a tool. **Med** | **BUILD** |
| **Todo / planning** | ❌ | ❌ | ✅ TodoWrite + Task* | `Tool.make` + panel. **Low** | **BUILD** |
| **MCP (consume)** | ❌ | ❌ | ✅ full client | `@effect/ai` hosts only; client custom. **High** | **MAYBE** |
| **MCP (expose)** | ❌ | ❌ | — | `McpServer.toolkit()`. **Low-med** | **MAYBE** |
| **Extension system** | ❌ (skills = knowledge) | ✅ runtime `.ts` extensions (jiti, `ExtensionAPI`) | ✅ plugins + bundled | **extensions-as-Layers** (Effect). **Med** | **BUILD** (on-thesis) |
| **Hooks (Pre/PostToolUse)** | ❌ (internal loop hooks only) | ✅ extension lifecycle events | ✅ shell hooks | event bus around tool calls. **Med** | **MAYBE** |
| **Permissions / approval** | 🟡 `allowBash`; confirm modal unwired | ❌ (unrestricted) | ✅ allow/deny + prompts | wire `promptForBash`. **Low-med** | **BUILD** (wire) |
| **AskUserQuestion tool** | ❌ (y/n modal only) | ❌ | ✅ | `Tool.make` → modal + `Deferred`. **Low-med** | **MAYBE** |
| **ToolSearch** | ❌ | ❌ | ✅ | only at large tool counts | **SKIP** (now) |
| **Skills** | ✅ `.efferent/skills` + `read_skill` | ✅ `.pi/skills` | ✅ bundled+local+MCP | — | keep |
| **Instruction files (CLAUDE.md)** | ✅ `AGENT.md` inject | 🟡 skills only | ✅ CLAUDE.md discovery | — | keep |
| **Memory dir / notes** | ❌ | ❌ | ✅ memdir | new port + retrieval. **Med** | **MAYBE** |
| **@-file references** | ❌ | ❌ | ✅ @-mentions | parse `@path`. **Low** | **MAYBE** |
| **History / resume** | ✅ Postgres + `--resume` | ✅ JSONL + branching | ✅ session store | — | keep |
| **Session branching** | ❌ flat history | ✅ `/branch` tree | ✅ | tree model. **Med** | **MAYBE** |
| **Cost tracking** | 🟡 token gauge | ✅ per-msg + session $ | ✅ cost_tracker | usage × pricing. **Low** | **MAYBE** |
| **Output styles** | ❌ | ❌ | ✅ | cosmetic | **SKIP** |
| **Keybindings config file** | 🟡 vi/insert, no file | ✅ via extensions | ✅ keybindings.json | — | **SKIP** |
| **Slash commands** | 🟡 11 hardcoded | ✅ built-in + extension | ✅ ~207 | as-needed | as-needed |
| **Scheduling / cron / remote** | ❌ | ❌ | ✅ Cron*/RemoteTrigger | off-thesis | **SKIP** |
| **Team / coordinator** | ❌ | ❌ | ✅ `coordinatorMode` | heavy | **SKIP** |
| **LSP tool** | ❌ | ❌ | ✅ `LSPTool` | big integration | **SKIP** (later) |
| **Image input** | ❌ | ❌ | ✅ | `Prompt` file parts. **Med** | **SKIP** (later) |
| **Plugins marketplace** | ❌ | ✅ (extension system) | ✅ `builtinPlugins` | see Extension system | (covered) |

---

## How pi compares (the closest peer)

The big 3-way table above puts us next to *both* pi and the full Claude Code surface. pi is the fairer mirror — a serious TS coding agent of roughly our scope — so two takeaways from those columns:

1. **pi shares most of our "skips."** No sub-agents, no todo, no MCP, no permission gates, no @-mentions — a real peer agent deliberately omits exactly what we marked SKIP/MAYBE. Good signal our verdicts are sane (Claude Code's breadth is the outlier, not our leanness). **One divergence:** we now ship **web tools** — `web_fetch` + a native `web_search` — where pi has neither as a first-class tool (only implicit provider-side search).
2. **pi's lead is presentation + compaction + extensibility**, not raw tools: rendered diffs, collapsible/streaming tool UI, real compaction, session branching, and a runtime extension system. Those are our genuine gaps against a peer — and they're exactly Tier 1/2 of the roadmap.

**Architecture contrast (the wedge).** pi proves you can build an excellent agent in plain TS (typebox schemas + async/await + native provider SDKs — no Effect, no zod). Our differentiation therefore isn't the feature list — it's the **Effect substrate**: ports/adapters as Layers, `@effect/ai` Toolkits, services. The on-thesis answer to pi's extension system is **extensions-as-Layers**: an extension is an Effect `Layer` that merges a `Toolkit` (+ hooks) into the agent at composition — typed, no `jiti`/runtime-eval. That's literally the "extend the agent through Effects" goal that drove our migration, and it's the most defensible thing to build *and write about*.

---

## The named gaps, in depth

- **Tool showcasing & diffs (highest visible payoff).** We already compute everything; we just *don't show it*. `edit_file` returns a `unifiedDiff`, `bash` returns full stdout — both get reduced to a one-line pill (`describeToolResult`). Claude Code renders a syntax-highlighted diff and collapsible output per tool. Plan: render the unified diff (ANSI red/green) in the scrollback for `edit_file`/`write_file`, and make tool output **expandable** (a key to toggle full output, scrollable). No model/loop change — pure TUI.
- **Web search — done (provider-native, no extra key).** Shipped as a self-contained `web_search` tool backed by a `WebSearch` port + `WebSearchLive` adapter. Each call is a **dedicated, grounding-only** `generateText` carrying *only* the provider's server-side search tool (`GoogleTool.GoogleSearch` / `OpenAiTool.WebSearch`, `requiresHandler:false`), returning `{ answer, sources }` (citations from `UrlSourcePart`s). Deliberately a *separate* call rather than merging the search tool into the agent's toolkit — so it needs no key beyond the LLM provider key, and sidesteps Gemini's refusal to combine grounding with function tools in one request. Configured independently of the chat `/model` (`EFFERENT_SEARCH_MODEL`, else whichever provider key is set). Pairs with the generic `web_fetch` (over `HttpClient`) to read a chosen source. *(We considered a bundled Brave-skill engine too, but dropped it once native search landed — Brave now needs a card.)*
- **Extensibility.** Today = skills + instruction files (good, on-thesis). Claude Code = plugins + hooks + MCP. `@effect/ai` gives us **MCP server hosting for free** (expose our toolkit), but **no MCP client** — consuming external MCP servers is a real build. Recommend: MCP *server* (cheap, lets us plug into other agents) soon; MCP *client* + shell hooks later.
- **Compaction.** Hook is already called every turn (`agentLoop.ts:48`) but no-ops. `Tokenizer` (+ `OpenAiTokenizer`) gives token counts/truncate; there's no built-in summarizer, so we implement `onTransformContext`: when input tokens exceed a budget fraction of `contextWindow`, summarize old turns via a cheap model call and replace them. Ties into the gauge we already show.
- **Memory references.** We inject `AGENT.md` and have Postgres history, but no **memory dir** (persistent cross-session notes with retrieval) and no **@-file references** in user input. Both are additive; @-refs are trivial, a memory port is medium.

---

## Roadmap (prioritized, on-thesis first)

**Tier 1 — visible polish + capability, all low/med effort, all great content:**
1. ✅ **DONE — Render diffs** for `edit_file`/`write_file` in the TUI (ANSI unified diff).
2. ✅ **DONE — Expandable/scrollable tool output** (Ctrl-R toggles full bash/grep/read output).
3. **Streaming** *(the remaining Tier-1 item, and the next build)* — `streamText` per turn; map `StreamPart`s to `AgentEvent`s for token-level text + live tool args. *Files:* `core/usecases/agentLoop.ts`, `core/usecases/promptMapping.ts`, `cli/src/events.ts`, `adapters/src/llm/router.ts` (router already implements `streamText`).
4. ✅ **DONE — Web search + web_fetch tools** — `web_fetch` (`Http` port) + a self-contained `web_search` (own `WebSearch` port + `WebSearchLive`: dedicated grounding-only provider call, no extra key). *Note:* deliberately **not** merged into the chat toolkit/router as first considered — a separate grounding call avoids the multi-tool grounding constraint.

**Tier 2 — capability depth, medium effort:**
5. **Compaction** — implement `onTransformContext` with `Tokenizer` + summarization; trigger off the token gauge. *Files:* new `core/usecases/compaction.ts`, wire in `cli/src/modes/*`, Tokenizer layer in `adapters`.
6. **Sub-agent delegation** — re-add `delegate_to_*` as `@effect/ai` tools whose handler runs a nested `runAgentLoop`. *Files:* new `core/usecases/delegationToolkit.ts`, `coderAgentConfig.ts`, reuse `discoverScopedAgents.ts` + `executionTree.ts` subagent events.
7. **Todo/planning tool** + TUI panel. *Files:* `core/usecases/codingToolkit.ts` (add `todo_write`), `cli/src/tui/sidePane.ts`.
8. **Wire bash-confirm** in TUI (`promptForBash` → `onBeforeToolCall`) + a small allow/deny permission config. *Files:* `cli/src/modes/tui.ts`, `core/entities/Settings.ts`.

**Tier 3 — extensibility, later:**
9. **MCP server** (expose our toolkit via `McpServer.toolkit()`), then **MCP client** (custom) + **shell hooks** (Pre/PostToolUse).
10. **Memory dir + @-file refs**; **cost tracking**; **image input**; **LSP tool**.

**Consciously skipping** (off-thesis for a lean Effect CLI): plugins marketplace, Team/coordinator multi-agent, output styles, cron/remote scheduling, ToolSearch, full keybindings editor. Revisit only if a concrete need appears.

---

## Bottom line

We're not far behind on *capability foundations* — the loop, multi-provider routing, tools, skills, instruction files, and persisted history are solid. Most of the early visible gaps have closed: **diffs, expandable output, web fetch, and web search are done.** What remains is **token-level streaming** (presentation) and a few **high-value tools** (sub-agents, todo) — all low/medium effort on the Effect stack, and strong build-in-public content. The genuinely large, off-thesis items (plugins, Team mode, cron/remote, LSP) we skip on purpose: a lean Effect agent doesn't need to be Claude Code to be sharp at its wedge.

Measured against **pi** — our true peer — the gap is narrower and clearer: we match its tool set (and now exceed it on web tools), share its deliberate omissions, and have closed **rendered diffs + collapsible tool UI.** We still trail on **streaming tool UI, real compaction, session branching, and a runtime extension system.** Close those (Tier 1/2) and we're at peer level on UX, with the Effect substrate (extensions-as-Layers, colocated evals) as the wedge pi doesn't have.

---

# Appendix: full discovery results

The detailed, file-path-level findings the comparison above is distilled from. Three explorations: (A) the Claude Code surface as catalogued by claw-code, (B) our agent's current state, (C) what the installed `@effect/ai` stack already provides.

## Appendix A — Claude Code feature surface (via claw-code)

`claw-code`'s Python `src/` is largely a **catalogue** of the leaked Claude Code harness: JSON snapshots under `src/reference_data/` (`tools_snapshot.json`, `subsystems/*.json`) + thin Python placeholders. The real implementations are archived TypeScript / partially in the Rust port. So this is "what Claude Code *has*," not what claw-code *runs*.

1. **Tool-call & result display.** `src/reference_data/subsystems/components.json` (~389 React/TSX components — e.g. `BashModeProgress.tsx`, `AgentProgressLine.tsx`, `ContextSuggestions.tsx`) renders tool invocations, spinners, collapsible results. `src/ink.py` is a minimal Ink placeholder (`render_markdown_panel()`); `subsystems/hooks.json` (~104 modules) carries tool/UI notification hooks. Mechanism: layered React components per tool.
2. **Diffs.** `src/reference_data/subsystems/native_ts.json` → `native-ts/color-diff/index.ts` (syntax-highlighted unified diff). `tools_snapshot.json` → `FileEditTool` with a `UI.tsx` that invokes color-diff. Diffs render as highlighted unified diff in the TUI.
3. **Web tools.** `tools_snapshot.json` → `WebSearchTool` (`WebSearchTool.ts` + `UI.tsx` + `prompt.ts`) and `WebFetchTool` (`+ preapproved.ts`, `utils.ts` — tracks preapproved domains). Provider-native vs generic HTTP not shown in the snapshot (impl archived).
4. **Extensibility.** Plugins: `src/plugins/__init__.py` placeholder + `subsystems/plugins.json` (minimal). Hooks: `src/hooks/__init__.py` placeholder (~104 modules); `PreToolUse`/`PostToolUse` parsed via settings but not executed in Python/Rust (per `PARITY.md`). Skills: `subsystems/skills.json` (~20 modules — bundled registry `batch`/`claudeApi`/`debug`/`loop`/`remember`/`scheduleRemoteAgents`/`simplify`/`updateConfig`/`verify` + loaders `loadSkillsDir`/`mcpSkillBuilders`/`bundledSkills`). Output styles: `subsystems/outputStyles.json` (`loadOutputStylesDir.ts`). Commands: `src/commands.py` loads ~207 (`get_commands`/`find_commands`/`execute_command`); `src/command_graph.py` token-match routing. Keybindings: `src/keybindings/` placeholder (config lives in settings).
5. **Context compaction.** `src/session_store.py` (`StoredSession`: session_id, messages, input/output token counts → `.port_sessions/*.json`); `src/history.py` (`HistoryLog`). No auto-compaction / microcompaction reimplemented in Python; archived TS had `services/SessionMemory/` (`sessionMemory.ts`, `sessionMemoryUtils.ts`).
6. **Memory & references.** `src/memdir/__init__.py` placeholder for an 8-module subsystem (`findRelevantMemories.ts`, `memdir.ts`, `memoryAge.ts`, `memoryScan.ts`, `memoryTypes.ts`, `paths.ts`, `teamMemPaths.ts`, `teamMemPrompts.ts`); `subsystems/memdir.json`. CLAUDE.md discovery is implemented in the Rust port. Full session/team memory + @-references live in archived TS.
7. **Other tools/UX.** `tools_snapshot.json` enumerates the full set: `TodoWriteTool`, `Task*` (`TaskCreate/Get/List/Update/Stop/Output`), `RemoteTriggerTool`, `CronCreate/Delete/List`, `AgentTool` (~19 modules: `builtInAgents`, `loadAgentsDir`, `runAgent`, `resumeAgent`, `agentMemory`, `planAgent`, `verificationAgent`, `statuslineSetup`…), `LSPTool` (~5 modules incl `symbolContext.ts`), `AskUserQuestionTool`, `ToolSearchTool`, MCP family (`MCPTool`, `McpAuthTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`). `subsystems/coordinator.json` → `coordinatorMode.ts` (Team orchestration). Cost: `src/costHook.py`, `src/cost_tracker.py`. `subsystems/services.json` (~130 modules: API client, OAuth, MCP, Datadog/GrowthBook analytics, session memory, prompt suggestion, policy limits, team-memory sync, voice, notifier).

**Takeaway:** claw-code is best used as a feature *index* and parity audit (enumerable tool/command/subsystem registries), not a feature-complete CLI. The rich rendering/streaming/MCP/OAuth/orchestration logic is archived in the original TS.

## Appendix B — our agent's current state

TypeScript / Effect.ts / Bun, hexagonal (`packages/core`, `adapters`, `cli`). Verdicts: EXISTS / PARTIAL / ABSENT.

1. **Tool-call & result display — EXISTS (minimal).** `cli/src/tui/toolDescribe.ts`: `describeToolCall()` → one-line labels (`read keys.ts L1-40`, `$ npm test`, `grep pattern`); `describeToolResult()` → summary stats (`+6/-2`, `exit 0`, `12 matches`, error truncated to 60 chars). `scrollback.ts`: colored-dot pills, ≤6 dim detail lines. `executionTree.ts`: turn → tool → result tree with elapsed + status. **Not collapsible/expandable; full output never shown;** bash stdout/stderr truncated (32KB/8KB in the handler).
2. **Diffs — PARTIAL.** `core/usecases/codingToolkit.ts`: `edit_file` calls `unifiedDiff()` and stores it in the success struct; `describeToolResult()` only counts +/- → `+6/-2` on the pill. **Full diff is generated but never rendered.**
3. **Web tools — EXISTS.** Toolkit: `read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`, `ls`, `read_skill`, **`web_fetch`** (`Http` port; HTML→text), **`web_search`** (native provider grounding via the `WebSearch` port + `WebSearchLive` — a dedicated, grounding-only call returning `{ answer, sources }`; see the named-gaps section).
4. **Extensibility — PARTIAL.** Skills: EXIST (`loadSkills.ts`, `.efferent/skills/*.md` ancestor-walk + home, frontmatter, `read_skill({name})`, one-liners in prompt). **Sub-agent delegation: ABSENT — _correction to first-pass research:_** `discoverScopedAgents.ts` exists and `coderAgentConfig` still threads `scopedAgents` into the prompt, **but there is no `delegate_to_*` tool** in the toolkit (verified: the 8 tools above only; no delegation refs in `core/usecases`). It was dropped in the `@effect/ai` migration (depended on the old `Llm` port); only discovery + prompt remnants survive. Instruction files: EXIST (`discoverInstructionFiles.ts`, `AGENT.md`/`AGENT.local.md`, root→cwd→home, dedupe, 4K/file + 12K total caps, injected under `# Instructions`). MCP: ABSENT. Plugins/hooks: ABSENT. Slash commands: hardcoded in `slashPalette.ts` (`/exit`,`/quit`,`/clear`,`/help`,`/cwd`,`/reset`,`/settings`,`/set`,`/model`,`/vi`). Editor: vi/insert modes (`/set editorMode`), no user-editable keybindings file.
5. **Context compaction — PARTIAL (stub).** `onTransformContext?` declared in `core/entities/AgentHooks.ts`, **called every turn at `agentLoop.ts:48`**, but no mode wires an implementation → no-op. `maxSteps` default 20 (hardcoded in `agentLoop.ts`). Token gauge in the status bar is **display only** — no budget enforcement.
6. **Memory & references — EXISTS (subset).** Conversation history persisted in Postgres (`conversationStore/postgres.ts`, JSONB, `--resume <uuid>`). Instruction files + skills injected. **No `@`-file reference syntax; no memory directory** beyond flat history.
7. **Other — PARTIAL.** TodoWrite: ABSENT. AskUserQuestion tool: ABSENT. ToolSearch: ABSENT. Permissions: MINIMAL (`allowBash` boolean; TUI hardcodes `allowBash: true`). Bash confirm: `promptForBash()` modal **defined in `tui.ts` but never wired** to `onBeforeToolCall`. Cost: status-bar tokens only, no $ calc. Streaming: ABSENT (`generateText` one-shot). Resume: EXISTS.

## Appendix C — what the `@effect/ai` stack already provides

Installed: `@effect/ai@0.35.0`, `@effect/ai-google@0.14.0`, `@effect/ai-openai@0.39.2`.

1. **Web search / grounding (provider-native).** `@effect/ai-google` `GoogleTool.d.ts`: `GoogleSearch` (no args), `GoogleSearchRetrieval` (`mode`, `dynamicThreshold`), `CodeExecution`, `UrlContext`. `@effect/ai-openai` `OpenAiTool.d.ts`: `WebSearch` (`user_location`, `search_context_size`, `allowed_domains`), `WebSearchPreview`, `CodeInterpreter`, `FileSearch` (vector-store, ranking/hybrid). All are `ProviderDefined` with `requiresHandler:false` (provider-executed). **Grounding is essentially free**; OpenAI's is richer (location/domain filters). *(Now wired: our `web_search` tool runs one of these in a dedicated grounding-only call via the `WebSearch` port — see Appendix B.3 / the named-gaps section.)*
2. **MCP — server only.** `McpServer.d.ts`: `make()`, `layer()`, `layerStdio()`, `layerHttp()`, `layerHttpRouter()`, `registerToolkit()`, `registerResource()`, `registerPrompt()`, `toolkit()` (Toolkit→MCP bridge), `elicit()`. `McpSchema.d.ts`: protocol types. **No client APIs** → `@effect/ai` can *host/expose* an MCP server but **cannot consume** external MCP servers; importing external MCP tools is a custom build.
3. **Streaming — full.** `Response.d.ts` `StreamPart` variants: `TextStart/Delta/End`, `ReasoningStart/Delta/End`, `ToolParamsStart/Delta/End`, `ToolCallPart`, `ToolResultPart` (`isFailure`,`result`), `FilePart`, `DocumentSourcePart`, `UrlSourcePart`, `ResponseMetadataPart`, `FinishPart` (`reason` + usage incl. `reasoningTokens`/`cachedInputTokens`), `ErrorPart`. `LanguageModel.streamText` → `Stream<StreamPart>`. Token-level text + live tool-arg deltas + token counts all available.
4. **Tokenizer / compaction.** `Tokenizer.d.ts`: `Tokenizer.Service` with `tokenize(Prompt)→Effect<number[]>` and `truncate(Prompt, tokens)→Effect<Prompt>`; `Tokenizer.make()`. `OpenAiTokenizer.d.ts`: `make({model})`, `layer({model})`. `Chat.d.ts`: stateful `Chat.Service` (`history: Ref<Prompt>`, `export`/`exportJson`, history-maintaining `generateText`/`streamText`, `Chat.empty`/`fromPrompt`/`fromExport`/`fromJson`, `Chat.Persistence`). **No built-in summarization/compaction/windowing** — we implement on top of `Tokenizer` + the `onTransformContext` hook.
5. **Tool definition richness.** `Tool.make()`: `parametersSchema`, `successSchema`/`failureSchema`, `failureMode: "error"|"return"`, `annotations: Context`, helpers `annotate`/`addDependency`, annotation tags `Tool.Title`/`Readonly`/`Destructive`/`Idempotent`/`OpenWorld`. `Tool.providerDefined()`: `args`, `providerName`, `requiresHandler`, `decodeResult`. Results: `HandlerResult` (`isFailure`, `result`, `encodedResult`); `ToolCallPart` (`providerName`, `providerExecuted`, `params`); `ToolResultPart` (`isFailure`, typed `result`, `encodedResult`, `providerExecuted`). Enough metadata for richer display (no native diff/structured-render field — we render).

**Effort summary:** grounding/web search — trivial (native tools); token-level UI — low (stream parts designed for it); compaction — low-med (Tokenizer + hook); rich tool/diff display — low (metadata present, rendering is ours); MCP *consume* — moderate-to-high (no client); MCP *expose* — low-med.

## Appendix D — pi feature surface (the closest peer)

Monorepo at `~/Workspace/xandreed/pi`: `packages/agent` (runtime: tool calling + session/state), `packages/ai` (unified multi-provider LLM API), `packages/coding-agent` (interactive CLI), `packages/tui`. Plain erasable TypeScript — **no Effect, no zod**; typebox for schemas; native provider SDKs.

1. **Tool-call & result display.** `coding-agent/src/modes/interactive/components/tool-execution.ts` — `ToolExecutionComponent` wraps built-in + extension tools; collapsible (`expanded`), **live partial results** (`isPartial`), per-tool `renderCall()`/`renderResult()` from `ToolDefinition`, with "self-render" vs "container-render" modes and pending/complete styling.
2. **Diffs.** `coding-agent/src/core/tools/edit-diff.ts` uses the `diff` npm package; `.../components/diff.ts` renders colored lines (red/green/dim) with **word-level intra-line highlighting** via `diffWords`, preserved line numbers, tab normalization, toggle-expandable.
3. **Web tools.** **None** built-in — only local file ops (read/write/edit/bash/grep/find/ls). All HTTP goes through `packages/ai` provider abstraction (`http-dispatcher.ts` + native SDKs). Web capability is provider-side only (Anthropic search, OpenAI browsing) — same posture as us.
4. **Extensibility / self-extensible (headline).** `coding-agent/src/core/extensions/{loader,types,wrapper,runner}.ts` — dynamically loads `.ts` files from `.pi/extensions/` at runtime via **jiti**. An extension is a default-export `ExtensionFactory` receiving an `ExtensionAPI`; it can: register custom **tools** (typebox schemas + `renderCall`/`renderResult`), register **commands** (slash/keybinding/CLI flag), subscribe to **lifecycle events** (turn start, tool exec, message flow) via an event bus, provide **UI components** (widgets/footer/header/editor/autocomplete), and call agent methods (bash, read/write, trigger compaction, keybindings). Runtime-discoverable, validated for name conflicts, hot-reload via `/reload`, bundled into the Bun binary via virtual modules. **No MCP; no codegen — pure TS modules** sharing the main package's import surface.
5. **Compaction.** `agent/src/harness/compaction/{compaction,branch-summarization}.ts` — per-message token tracking + estimation; manual `/compact` summarizes explored branches; token-budgeted summarization preserves file-read/modified metadata and replaces a branch in the session tree with a summary entry; compaction prompt customizable via extensions.
6. **Memory & references.** Session history as **JSONL** (`agent/src/harness/session/jsonl-storage.ts`), hierarchical **branching tree** (entries reference parents; navigate/resume branches). Skills (`agent/src/harness/skills.ts`, `coding-agent/src/core/skills.ts`) = `.md` in `.pi/skills/` with YAML frontmatter (name, description, `disable-model-invocation`), formatted into the system prompt. **No @-mention system, no semantic/vector memory.**
7. **Streaming.** Built into `packages/ai` (`stream.ts` `stream()`/`streamSimple()`); providers implement `StreamFunction` returning an `AssistantMessageEventStream` (async iterable of partial messages: text deltas, tool calls, thinking blocks). No non-streaming mode — `complete()` just awaits the stream end. TUI re-renders per event; tool results stream live.
8. **Other.** Sub-agents/delegation: **none** (single-agent loop). Todo tool: **none**. Permissions/approval gates: **none** (tool exec unrestricted once configured; bash can route via `BashOperations`, e.g. SSH). Cost tracking: **yes** — per-message usage + session $ from model pricing (`cost.input/output/cacheRead/cacheWrite`), informational (no budgeting). Slash commands: `/compact`, `/reload`, `/resume`, `/branch`, `/debug`, `/export` (HTML) + extension-registered.

**Architecture / stack.** Tools = typebox `Type.Object(...)` runtime-validated schemas; implementations are plain async functions returning result + optional details/error flag. Provider abstraction = `stream<TApi>()` over a string-union of APIs (`"anthropic-messages"`, `"openai-responses"`, …) registered in `api-registry.ts`, each a `StreamFunction` with env-var auth (`env-api-keys.ts`). Direct async/await, no monadic pipeline. Deps: typebox, yaml, ignore, native SDKs (Anthropic/Google/OpenAI/Mistral/Bedrock). Built with esbuild + node strip-only mode. **The contrast with us is the whole point:** pi is a great agent in plain TS; our bet is that the Effect substrate (Layers, Toolkits, services, colocated evals, extensions-as-Layers) is a better foundation — which is the thing to prove in public, not the feature count.
