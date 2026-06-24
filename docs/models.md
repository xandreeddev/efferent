# Model usage map

Every place efferent calls an LLM, which selection backs it, how the key resolves, and
where the spend lands. The companion concept doc is the **roles** section in `AGENT.md`
(general / code / fast); this is the exhaustive call-site inventory.

## The one rule

A running agent NEVER picks its own model — its **role** is structural, and the router
resolves it from the run's frozen `RunContext.pinnedModels`. The tool loop runs on
**general** (the root + research/analysis sub-agents) or **code** (coding sub-agents),
through the router `LanguageModel`; the spawner picks the tier (`run_agent({ role })` /
the agent definition's `role:`), never a specific model. Everything else is a **one-shot
helper call** through `UtilityLlm.complete(prompt, { role: "fast" })`. Web search is the
deliberate exception (a provider-server-side tool, not a chat completion). No other module
may call a provider SDK.

## Inference call sites

| # | call site | purpose | service → selection | spend lands in |
|---|-----------|---------|---------------------|----------------|
| 1 | `core/usecases/agentLoop.ts` (`LanguageModel.generateText`, one per turn) | the **root conversation** — every turn of every mode (TUI / print / json / rpc) | router → **general** (`pinnedModels.general`, frozen at run start, per call) | gauge (`inputTokens` = last turn) · `byRole.general` · persisted on the assistant message (`providerOptions.efferent`) · per-turn `N tok` tree detail |
| 2 | same loop, run by `runSpawnedAgent` (`buildScopeRuntime.ts`) | **sub-agents** — every `run_agent` spawn/branch/handoff/resume + the human node-resume | router → the sub-agent's **role** (`RunContext.modelRole`: `code` for coders, `general` for research/analysis) | node `usage` (`ContextTreeStore`) · shared per-turn **token pool** drain · `byRole.{general,code}` by role (via the `assistant_message` event's `subAgentRole`) — never the gauge |
| 3 | `core/usecases/handoff.ts` (`generateHandoffBrief`) | **handoff briefs** — `:handoff` (fold-in-place) and `run_agent seedMode:"handoff"` seeds | `LanguageModel` direct → router → the spawning fiber's role (general for the root) — quality-critical: the brief *is* the continuity | **nowhere — known gap** (not evented, not in `byRole`) |
| 4 | `core/usecases/generateTitle.ts` (`generateSessionTitle`) | **session titles** after a session's first exchange | `UtilityLlm` → **fast** (`fastModel` ?? general) | `byRole.fast` (fed by the title daemon in `actions/submit.ts`) |
| 5 | `adapters/src/llm/webSearch.ts` (`WebSearchLive`, grounding-only `generateText`) | the **`search_web` tool** — a dedicated request carrying only the provider's server-side search tool | own per-call client (NOT the router): `Settings.searchModel` → `EFFERENT_SEARCH_MODEL` env → logged-in Google (preferred) / OpenAI | **nowhere — known gap** |
| 6 | `evals/src/framework/scorers.ts` (`llmJudge`) | **eval scoring** (LLM-as-judge) | the eval env's model layer; keys from `EnvAuthStoreLive` (the only env-var key reading in the tree) | the eval report only (out-of-app by design) |
| 7 | eval suites running the real loop (`runCoder`, the handoff suite) | **eval tasks** | same as #1 under the eval env | eval report only |
| 8 | `core/usecases/compaction.ts` (`compressToolResults`, called per loop step) | **compaction middle digests** — a ≤120-word summary of an oversized tool result's dropped middle, woven into the clip marker | `UtilityLlm` → **fast** (`fastModel` ?? general) — the fast role's first consumer | `byRole.fast` (via the `onHelperUsage` hook → `helper_usage` event; sub-agent loops forward to the parent ledger) |
| 9 | `core/usecases/autoApproval.ts` (`judgeApproval`), consulted by the TUI `Approval` impl (`tui-solid/approval.ts`) | **auto-approval judgments** — classify an unmatched bash command against the permitted folders: allow silently or escalate to the modal (never bypasses a prompt; `:set autoApprove off` disables) | `UtilityLlm` → **fast** (`fastModel` ?? general) | `byRole.fast` (counted directly by the approval impl, like the title daemon) |

## How a selection becomes a client

The router (and `UtilityLlm`, and web search) build the provider client **per call** via
`makeProviderLanguageModel` (`adapters/src/llm/providers.ts`): Google / OpenAI (plus the
Codex OAuth variant in `openAiCodex.ts`) / Anthropic (API key or subscription OAuth with
the Claude-Code system block) / OpenCode (`openCode.ts`) / Ollama (`ollama.ts`). Keys come
from `AuthStore.resolveKey` per call (refreshing near-expiry OAuth first), so `:login`,
`:model`, and `:set …Model` all apply on the **next run** with no rebuild — within a run
the role models are frozen (`pinnedModels`) so a switch can't move a live fleet.

## Non-inference provider traffic

Not model usage, listed for completeness: `ModelRegistry.list` (the live catalogue —
Google/OpenAI/Anthropic models endpoints, logged-in providers only) and OAuth token
refresh. Neither bills tokens.

## Accounting summary

`SessionStats.byRole {general, code, fast}` is the session ledger: the root loop →
**general**; each sub-agent → **its role** (`code`/`general`, carried on the
`assistant_message` event's `subAgentRole`); helper calls → **fast**, reported by
`UtilityLlm`'s `{ text, usage }` return. Rebuilt (resumed) sessions recover general only —
node spend stays on nodes (`:tree` shows it per agent).

**Known gaps** (uncounted spend): handoff briefs (#3) and web search (#5). Both are real
billed tokens; routing their usage into `byRole` is the next accounting slice — web
search would need `WebSearch` to return usage alongside `{ answer, sources }`, and the
handoff path would need `generateHandoffBrief` to report usage to its caller.
