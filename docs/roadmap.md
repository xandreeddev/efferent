# Roadmap

Living backlog of what's **not yet built** in efferent — what's coming next, what's optional, and what we're consciously skipping. Up to date with `main` as of the last edit to this file.

For *what's shipped*, see `AGENT.md` (architecture) and `README.md` (feature tour).

---

## Tier 1 — next up (visible polish + capability)

These are low-to-medium effort on the current Effect stack and unlock the biggest UX wins.

### Token-level streaming
The loop uses `LanguageModel.generateText` per turn (one round-trip → one append). Switch to `LanguageModel.streamText` and map `Response.StreamPart`s (`TextStart/Delta/End`, `ReasoningStart/Delta/End`, `ToolParamsStart/Delta/End`, `ToolCallPart`, `ToolResultPart`, `FinishPart`) onto new `AgentEvent` variants. The router already implements `streamText`; the pieces to touch are `core/usecases/agentLoop.ts`, `core/usecases/promptMapping.ts`, `cli/src/events.ts`, and the scrollback's assistant-block renderer (it needs to accept partial text and live-update). Tool-arg deltas can drive a "tool call forming" pill state.

### Wire a bash-confirm modal
The TUI passes `allowBash:true`; there is no per-command confirm yet (the old `promptForBash` stub was removed with the hand-rolled driver at cutover). Plan: build a small `Approval` service in `@efferent/core` (a port with `requestApproval({ tool, summary, cwd })`), call it from the `Bash` handler when an `approvalRequired` flag is set on `codingToolkitLayer`, and provide a TUI-mode implementation that opens a new OpenTUI overlay (a `{kind:"confirm"}` variant in `tui-solid/state/overlay.ts`, routed by `keys/overlay.ts`). Non-interactive modes keep the `allowBash` gate. Pairs well with a `permissions` config block on `Settings` (allow / deny / prompt lists).

### Compaction
`onTransformContext` is wired (`agentLoop.ts:48`) but no mode provides an implementation. Implement `core/usecases/compaction.ts`: when input tokens exceed a budget fraction of `LlmInfo.contextWindow`, summarise the older window via a cheap model call and replace those turns with a single synthetic message — the same shape `handoffToMessage` already produces for `:handoff`. `@effect/ai`'s `Tokenizer` gives us counts. Trigger off the status-bar gauge that's already shown. Requires the three-tier model selection below (or a fixed cheap model).

### Three-tier model selection (`main` / `fast` / `cheap`)
Today `Settings.model` is a single `"<provider>:<modelId>"`. Two more tiers would let:
- **fast** — sub-agent loops, single-file edits, syntax checkups (e.g. `gemini-2.5-flash`, `claude-haiku`)
- **cheap** — background compaction, turn-summarisation, token math (e.g. `gemini-2.5-flash-lite`, `gpt-4o-mini`)

Touch points: extend `Settings` schema with `fastModel?` / `cheapModel?`; teach `ModelRegistry` to expose `current(tier)`; have `runAgent` accept a tier hint (sub-agents default to `fast`); compaction always uses `cheap`. `:model` keeps switching `main`; add `:set fastModel <…>` / `:set cheapModel <…>`.

---

## Tier 2 — capability depth

### Per-conversation OpenAI `prompt_cache_key`
Today the router sets a stable static `prompt_cache_key`. Threading the conversation id would tighten cache routing across resumed sessions. Single-file change in `adapters/src/llm/router.ts`.

### Explicit Gemini context caching
Implicit context caching is live (stable prefix → `cachedContentTokenCount` surfaces in the gauge). Explicit `cachedContent` resources would let us cache + reuse a known instruction/skill prefix across conversations — but `@effect/ai-google@0.14` always sends full `contents` and `Config` omits `contents`/`tools`/`systemInstruction`, so it isn't expressible without forking the adapter. Watch upstream; reconsider when a `Config.cachedContent` lands. Cost optimisation, not correctness.

### Wider code-highlight language coverage
Markdown prose, fenced code blocks, and diff hunks are all syntax-highlighted now (tree-sitter via `view/syntax.ts` + the `getTreeSitterClient()` singleton; `web-tree-sitter` is a declared dep, the worker is destroyed on exit). But `@opentui/core` only bundles grammar WASM for **JS / TS / markdown / zig** (`assets/`), so python/rust/go/json/bash/yaml/etc. render un-highlighted. To extend: source the extra `tree-sitter-<lang>.wasm` + `highlights.scm` and register them via `client.addFiletypeParser({ filetype, wasm, queries })` (or ship them under a data dir + `setDataPath`). Decide whether to bundle a curated set (bigger install) or fetch-on-demand into `~/.efferent`. Also still un-styled: `#` heading **colour** in prose (marked headings route around the `markup.heading` scope, which only styles table headers — would need a custom `renderNode`).

### Human-driven resume/branch from `:tree`
The agent already resumes/branches persisted sub-agent contexts via `run_agent({ seedFromNode, seedMode })`, and `:tree` browses + drops (`d`) nodes. The missing half is a key in the tree view that *re-runs* a node from the UI: pick the node, choose resume vs branch, type the task — then drive a real run through the submit pipeline (event queue, busy flag, fiber ownership). All the seeding machinery exists in core; the work is TUI submit-level wiring.

### TodoWrite tool + planning panel
A `todo_write` tool in `codingToolkit.ts` + a foldable section in the activity pane (`sidePane.ts`) showing the live todo list. Cheap to ship, helps long multi-step turns stay coherent.

### MCP — expose
`@effect/ai`'s `McpServer.toolkit()` is a direct bridge from our existing toolkit to an MCP server. Means other agents can call into efferent — both as a CLI integration test surface and as a way to make our tools usable from Claude Desktop / Cursor / Cline. Low-med effort.

### `@`-file references in input
Parse `@path/to/file` in user input → expand to a `read_file` block prepended to the message (or to a fenced code block inline). Common UX in mature agents. Trivial parse; the question is what to do with binary paths and globs.

### Cost tracking
We already track `inputTokens` / `outputTokens` / `cacheReadTokens` per turn (status bar gauge). Multiply by per-model pricing for a session $ readout (and a per-turn one when expanded). Add a `pricing.json` (or a `Pricing` port that fetches it). Informational; no budgeting yet.

---

## Tier 3 — extensions + later

### MCP — consume
External MCP servers exposed as tools inside our loop. `@effect/ai` only hosts MCP servers today; consuming them needs a custom client. Material work. Wait until at least one MCP-only tool we want appears.

### Extensions-as-Layers
The on-thesis answer to pi's runtime extension system: an extension is a default-exported `Layer` that merges a `Toolkit` (and optionally hooks, slash commands, side-pane widgets) into the agent at composition. Typed end-to-end, no `jiti`/runtime-eval, validated for tool-name collisions. Discovery from `.efferent/extensions/` + `~/.efferent/extensions/`. This is the headline differentiator vs pi when we ship it.

### Shell hooks (Pre/PostToolUse)
A small event bus around tool calls — user-provided shell commands triggered on `pre-tool-use` / `post-tool-use` / `turn-end` for things like running a formatter after every `edit_file`. Pairs with the extension system. Claude Code has these.

### Memory directory
A `~/.efferent/memory/` (or per-project `.efferent/memory/`) with file-per-fact persistent notes the agent can `read`/`write`/`search`. New `Memory` port + a small retrieval policy (recency + keyword for v1; embeddings later). Pairs with the @-file references above.

### Session branching
Today top-level history is flat — `:resume <id>` continues a conversation, and `:context` + `:build` curates a new one. (The *sub-agent* layer already branches: `run_agent` resume/branch over the persistent context tree.) Conversation-level branching would let `:branch` fork from any point in the conversation viewer and switch between forks. The `checkpoints` table model already supports the data shape; the UI is the work.

### Image attachments
`@effect/ai` `Prompt` has `FilePart`s; the CLI just needs an input syntax (`:attach <path>`) and to encode the bytes. Useful for screenshots-of-errors flows.

### Live bash output streaming
Today bash returns stdout/stderr as a blob when done; streaming chunks back to the model in real time would let it react to long-running builds. Touches `Shell` port (currently `exec` → result) — need a `spawn` variant returning a stream.

### Native (non-shell-out) grep
`grep` shells out to system `grep -rnE`. A pure-TS implementation over `Bun.Glob` + `Bun.file` would remove the dependency and unlock structured matches (with context lines in the result struct, not just printed). Quality-of-life; not blocking anything.

### LSP tool
A real win for language-aware navigation (find-references, go-to-definition). Big integration — needs LSP client + a server-launcher per language. Park until the extension system lands; LSP is naturally an extension.

---

## Consciously skipped

These are *not* on the roadmap. Revisit only if a concrete need surfaces.

- **Plugins marketplace** — extensions-as-Layers is the on-thesis answer; a marketplace is off-thesis for a lean Effect CLI.
- **Team / coordinator multi-agent mode** — Claude Code's `coordinatorMode` orchestrates teams of agents. Heavy; `run_agent` over the persistent context tree (spawn / resume / branch, recursive) already handles the cases we actually need.
- **Cron / remote-trigger / scheduling** — agents that fire on a schedule or react to webhooks. Outside the CLI's wedge.
- **ToolSearch** — only useful at large tool counts (Claude Code carries a vast tool surface). With our handful, it's pointless.
- **Output styles** — purely cosmetic theming. We have the per-pane accent system; that's enough.
- **Full keybindings editor** — vi/insert + Ctrl-hjkl pane switching is the model; per-key remapping would only complicate it.
- **`tool.respond` safety prompts over RPC** — the RPC mode is a programmatic surface; if a host wants to prompt a human, it does so before sending the next message.

---

## Mouse support — keyboard-first, OpenTUI-native selection

Navigation is fully keyboard-modal: `Ctrl-hjkl` panes, `j/k`/arrows scroll, a **fold cursor** (`{}`/`[]` paragraph/message · `gg/G` ends · `⇥`/`↵` fold), `/` per-pane search. Since the OpenTUI cutover the renderer runs with `useMouse: true` — drag-select is OpenTUI-native and `y` yanks the selection to the clipboard via OSC 52 (this replaced the old hand-rolled TUI's "no mouse-reporting mode" stance). No other mouse interactions (clicking, scrolling panes) are bound, and none are planned — the keyboard is the interface.
