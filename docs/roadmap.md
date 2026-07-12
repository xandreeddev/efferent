# Roadmap — the agent line

Living backlog of what's **not yet built** in efferent — rewritten 2026-07-09
for the agent line (engine / providers / surface / foundry + smith / math /
canvas / social + scenarios). The previous revision of this file described
the OLD line (`packages/cli`, `agentLoop.ts`, the fleet/daemon) — deleted in
THE DROP (2026-07-07); its still-relevant items are carried over below, its
obsolete ones are recorded at the bottom so they stop reading as open.

For *what's shipped*, see the package `CLAUDE.md`s and `docs/foundry.md`.

---

## Recently closed (was on this roadmap; now on main)

| was | shipped as |
|---|---|
| Compaction (unimplemented hook) | within-attempt fold (engine `CompactionPolicy`, #163) + attempt-boundary fold (#159/#160) |
| Two-tier model selection | THREE roles (general/code/fast), config + flags + `:model`, role-scoped views |
| Per-turn persistence flush | incremental tail persistence + incremental run artifacts (#106, #61) |
| MCP — consume ("wait until needed") | engine `McpClient` port + progressive-disclosure bridge (`mcp_describe`/`mcp_call`, #168/#171) |
| Memory directory | memory v2 — curated JSONL ledger + brief injection (#164) + skills distill (#173) |
| Evals — independent judge | the judge GATE (default-ON, code tier, fail-closed, #165) + the trajectory critic (manual) |
| Extensions (as a concept) | SKILLS — file-based instructions, 3-tier progressive disclosure (#167); behavior stays build-in-code |
| Sandboxing | bubblewrap coder Bash, default ON (#169) |
| Post-accept git workflow | `:ship` — branch → commit → push → PR (#162) |

## Tier 1 — next up

### Token-level streaming
The engine loop is `generateText` per turn (one round-trip → one append);
providers' compat client is v1 non-streaming. Map `streamText` parts onto
new LoopEvents so the TUI shows text/reasoning as it forms and tool-arg
deltas can drive a "call forming" state. Touches: engine `loop.ts`/
`LoopEvent`, providers `compat.ts`, the conversation-pane assistant block.
The biggest visible-latency win on slow thinking models.

### Non-model settings in `:settings`
The settings menu (#176) edits the model roles only because the
`SettingsStore` port exposes `load` + `setRole` and nothing else. Extend the
port with a generic keyed setter (validated per key), then grow the menu:
`sandbox`, `maxAttempts`, `budgetMillis`, thinking mode. The menu UI already
composes the select overlay — this is a port + adapter change.

### TodoWrite + plan visibility
A `todo_write` tool in the coder toolkit + a side-panel section rendering
the live list. Cheap; keeps long forge attempts legible and feeds the
trajectory metrics (plan-adherence is measurable once the plan is data).

### Cost tracking
Usage (input/output/cache tokens) is already counted per turn and shown in
the gauge; multiply by per-model pricing for a session $ readout in the
frame footer. Needs a small `pricing` table (constant defaults, config
override) — informational, no budgeting.

### fallbackModel
The provider-outage ladder retries patiently but there is still no
cross-provider failover (`fallbackModel` is designed but unset). One
settings key + a router fallback rung.

## Tier 2 — capability depth

### TUI parity with the old line (deliberately re-earned, not ported)
The old TUI had: per-pane `/` search with highlight, turn/tool folding, a
fold cursor, vi-modal navigation, tree-sitter code highlighting, Ctrl-R
tool-output expand, ↑ prompt-history recall. The smith TUI re-built the
chassis lean; these come back one at a time as usage demands them. Next
candidates by live-session friction: **tool-output expand** (agy's
`ctrl+o`), **↑ history recall**, **vi mode** (deferred by user call
2026-07-09; the old `viMode` reducer survives in git history).

### `@`-file references in the composer
`@path` in a refine/task message expands to the file's content (bounded) in
the turn. Trivial parse; decide globs/binary policy.

### MCP — expose
`@effect/ai`'s `McpServer.toolkit()` bridges our toolkits to an MCP server:
other agents (Claude Desktop/Code, Cursor) could drive smith's tools. Low
effort, good build-in-public artifact.

### Judge calibration
The judge gate runs default-ON but has never been calibrated: build a small
labeled set (sound/unsound workspaces from real runs), measure
agreement/false-block rate, tune the prompt. Do before trusting the judge
on anything beyond intent/honesty.

### Foundry gate growth
- Mutation-testing gate (StrykerJS incremental) — the anti-"tests that
  assert nothing" meta-gate.
- fast-check property gate.
- Promote smith's command/test gate into foundry's built-ins.

### Scenarios v3 remainder
Config-matrix A/Bs, sharding, cost budgets, bootstrap change tests, and a
scheduled live trajectory-critic run. Sampling, pass@k/pass^k estimates,
Wilson intervals, judge-backed live packs, and raw-evidence baselines ship.

### Provider-level cache tightening
Per-conversation OpenAI `prompt_cache_key`; explicit Gemini `cachedContent`
when `@effect/ai-google` exposes it. Cost, not correctness.

## Tier 3 — later

- **Session branching** — fork a conversation from any message; the
  checkpoint model already supports the data shape, the UI is the work.
- **Image attachments** — `FilePart`s exist in `@effect/ai`; needs input
  syntax + encoding.
- **Live bash streaming** — `Shell.spawn` variant returning a stream so the
  model reacts to long builds mid-run.
- **Native grep** — pure-TS over `Bun.Glob` for structured matches.
- **LSP tool** — park until a concrete need; naturally skill-shaped.
- **Wider code-highlight coverage** — the new TUI has NO syntax
  highlighting yet; if/when it returns, `@opentui/core` bundles only
  JS/TS/markdown/zig grammars.

## Known rough edges

- `--cwd` outside the repo dies on the Solid preload (bunfig is
  cwd-relative) — error message should say so.
- Shell adapter: no process group on timeout kill; unbounded buffering
  before truncation.
- Fast input bursts: Enter in the same terminal chunk as text can land as a
  newline instead of running a `:` command.

## Dropped with the old line (recorded so they stop reading as open)

- **Channels & triggers / daemon / fleet cockpit** — the new line has no
  fleet; agents are packages. Revisit only if a product needs a daemon.
- **Approval beyond bash** — replaced by the doctrine: gates outside,
  sandbox around the coder, no in-loop approval judge.
- **`:tree` resume/branch** — no fleet tree; smith has `:resume` over
  conversations.
- **Old web UI follow-ups** — the web package was deleted; canvas is the
  UI-builder now.
- **Extensions-as-Layers marketplace framing** — superseded by
  skills (instructions) + MCP (external tools); behavior stays in code.

## Consciously skipped (unchanged)

Plugins marketplace · out-of-process coordinator · ToolSearch ·
output styles · full keybindings editor.
