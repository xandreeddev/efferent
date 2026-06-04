# Comparison: efferent vs Claude Code vs pi

Where efferent sits in the coding-agent-CLI landscape, against the two reference points that matter: Anthropic's **Claude Code** (the de-facto Pareto front of features) and **pi** (`~/Workspace/xandreed/pi`, the closest peer — a serious TS agent of roughly our weight class). Up to date with efferent `main`.

> **Framing.** The goal is *understanding*, not parity. efferent's wedge is **Effect services + ports/adapters + colocated evals + a modal TUI (OpenTUI + SolidJS, no React)**. Several Claude Code features are deliberately off-thesis. See `docs/roadmap.md` for what's planned and what we're consciously skipping.

---

## At a glance

| Capability | efferent | pi | Claude Code |
|---|---|---|---|
| **Tool-call display** | ✅ pills + tree + `Ctrl-R` expand | ✅ collapsible, live partial | ✅ per-tool React UI |
| **Inline diffs** | ✅ coloured unified diff | ✅ + word-level highlight | ✅ syntax-highlighted |
| **Token streaming** | ❌ `generateText` per turn | ✅ built-in | ✅ token + tool-arg deltas |
| **Web search** | ✅ `search_web` — own port, dedicated grounding-only call | ❌ (provider-side only) | ✅ |
| **Web fetch** | ✅ `web_fetch` (Http port) | ❌ | ✅ |
| **Multi-provider** | ✅ Gemini · OpenAI · Anthropic (OAuth) — runtime router | ✅ Anthropic / Google / OpenAI / Mistral / Bedrock | ✅ Anthropic-first |
| **OAuth subscription** | 🟡 Claude Pro/Max via `:login` (wire-complete, live round-trip unverified) | 🟡 env-key only | ✅ |
| **Compaction** | 🟡 hook wired, no impl | ✅ branch summarisation + `/compact` | ✅ auto + microcompaction |
| **Handoff (manual)** | ✅ `:handoff` + checkpoints + cumulative folds | ✅ via `/compact` | ✅ |
| **Context curation UI** | ✅ `:context` tree → `Space` select → `:build` new session | 🟡 branch tree | 🟡 |
| **Sub-agent delegation** | ✅ `SCOPE.md`-driven `delegate_to_<child>` tools | ❌ (single-agent) | ✅ AgentTool/Task/Team |
| **Todo / planning** | ❌ | ❌ | ✅ TodoWrite + Task* |
| **MCP — host (expose)** | 🟡 stack supports it, not wired | ❌ | — |
| **MCP — consume** | ❌ | ❌ | ✅ full client |
| **Extension system** | ❌ (planned: extensions-as-Layers) | ✅ runtime `.ts` (jiti, `ExtensionAPI`) | ✅ plugins + bundled |
| **Hooks (Pre/PostToolUse)** | ❌ | ✅ extension lifecycle | ✅ shell hooks |
| **Permissions / approval** | 🟡 `allowBash` flag; confirm modal unwired | ❌ (unrestricted) | ✅ allow/deny + prompts |
| **Skills** | ✅ `.efferent/skills/*.md` ancestor-walk + home, `read_skill` | ✅ `.pi/skills/` | ✅ bundled + local + MCP |
| **Instruction files** | ✅ `AGENT.md` + `AGENT.local.md`, dedup, 4K/file 12K total | 🟡 skills only | ✅ CLAUDE.md discovery |
| **Memory dir / notes** | ❌ | ❌ | ✅ memdir |
| **@-file references** | ❌ | ❌ | ✅ @-mentions |
| **History / resume** | ✅ SQLite (default) or Postgres + `--resume` | ✅ JSONL + branching | ✅ session store |
| **Session branching** | ❌ flat (curation via `:context` instead) | ✅ `/branch` tree | ✅ |
| **Cost tracking** | 🟡 token gauge only | ✅ per-msg + session $ | ✅ |
| **Headless modes** | ✅ `print` / `json` (JSONL) / `rpc` (JSON-RPC) | ✅ scriptable | ✅ |
| **Evals harness** | ✅ colocated (`packages/evals`) — Effect-native | ❌ | ❌ |
| **Image input** | ❌ | ❌ | ✅ |
| **Output styles** | ❌ | ❌ | ✅ |
| **Cron / remote / Team mode** | ❌ (off-thesis) | ❌ | ✅ |

Status legend: ✅ have · 🟡 partial · ❌ absent · — N/A.

---

## How efferent compares to pi (the closest peer)

pi shares most of our deliberate omissions — no sub-agents (we now ship them), no todo, no MCP, no permission gates, no @-mentions. That's good signal: a peer agent of our scope skips the same Claude Code breadth we mark off-thesis.

**Where pi is ahead of us:**
1. **Token-level streaming.** pi streams everything (no non-streaming mode); we currently render once per turn. Tier-1 in our roadmap.
2. **Real compaction.** pi has token-budgeted branch summarisation + `/compact`; our `onTransformContext` hook is wired but unused.
3. **Session branching.** pi's session tree lets you fork from any point. We replaced this with `:context`-driven *curation* into a new session (which keeps the original untouched) — different design, different trade-off.
4. **Extension system.** pi loads `.ts` files from `.pi/extensions/` at runtime via `jiti`, with a typed `ExtensionAPI`. Our planned answer is **extensions-as-Layers** — typed end-to-end, no runtime-eval, validated for collisions; the headline differentiator when it lands.
5. **Cost tracking** with per-message $.

**Where efferent is ahead of pi:**
1. **Web tools.** First-class `web_fetch` + native `search_web` (provider-side grounding through a dedicated `WebSearch` port). pi has neither — web capability is implicit provider-side only.
2. **Sub-agent delegation.** `SCOPE.md`-driven nested loops with scoped write permissions and rolled-up token usage in the activity tree. pi is single-agent.
3. **Anthropic OAuth (Claude Pro/Max subscription).** Browser flow + loopback callback + token refresh — wire-complete, though the live subscription round-trip is still unverified. pi is env-key only.
4. **Multi-provider router with runtime switching.** `:model` switches provider mid-session; the router resolves the key per request, so a `:login` mid-conversation takes effect on the next turn with no restart.
5. **Handoff + context-viewer curation.** `:handoff` writes a checkpoint and cumulatively folds prior summaries. `:context` is a navigable tree of turns and handoffs you can multi-select with `Space` and `:build` into a fresh, clean conversation. Turn granularity preserves tool-call/result pairs.
6. **Colocated, Effect-native evals.** `packages/evals` runs the real agent loop over a temp workspace with an in-memory `ConversationStore` — no Docker, no LLM in unit tests, key-gated for live suites. pi has none.
7. **The Effect substrate.** This is the actual wedge: ports as `Context.Tag`, adapters as `Layer.effect`, tools as `Tool.make` with `failureMode: "return"`, the whole thing typecheck-only (Bun runs `.ts` directly — no emit). pi is plain async/await + typebox. Different bet on what makes agent code maintainable.

**Architectural contrast.** pi proves you can build an excellent agent in plain TS. Our bet is that the Effect substrate (Layers, Toolkits, services, scoped errors) is a better foundation for an extensible, testable, multi-provider agent — which is the thing to prove in public, not the feature count.

---

## How efferent compares to Claude Code

Claude Code's surface is the ceiling — a vast tool/slash-command surface and dozens of subsystems: plugins, hooks, MCP, output styles, memory dir, Team mode, cron, remote triggers, LSP. A lean Effect CLI doesn't need to be Claude Code to be sharp at its wedge.

**The gaps we'll close** (in `docs/roadmap.md`):
- Token streaming, compaction, three-tier model selection, todo/planning, MCP host, @-file refs, cost $, extensions-as-Layers, hooks.

**The gaps we'll consciously skip:**
- Plugins marketplace, Team / coordinator mode, cron / remote triggers, ToolSearch, output styles, full keybindings editor.
- Mouse mode: deliberately *not* enabled — keeps your terminal's native click-drag selection working.

**The gaps that may stay open a while:**
- MCP consume (waiting for a tool we actually want).
- LSP (waiting for the extension system to land — LSP is naturally an extension).
- Image input (low cost, low demand from current users).

---

## Bottom line

efferent already matches pi on tool foundations and **exceeds** it on web tools, multi-provider routing, OAuth subscriptions, sub-agent delegation, and the evals harness. It still trails pi on streaming, compaction, and extensibility — all on the Tier-1/2 roadmap.

Against Claude Code's full surface we trail considerably on breadth (plugins, MCP, memdir, Team mode, image input) but match it on the fundamentals (rich tool display, diffs, web tools, OAuth, sub-agents, handoff, multi-provider) and *exceed* it in one specific dimension that matters for build-in-public: **the substrate**. An Effect-based agent with ports/adapters, typed errors, colocated evals, and a modal OpenTUI/SolidJS TUI is a different bet than "more features." That's the thing the roadmap protects.
