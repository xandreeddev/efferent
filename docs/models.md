# Model usage map

Every place efferent calls an LLM, which selection backs it, how the key resolves, and
where the spend lands. The companion concept doc is the **roles** section in `AGENT.md`
(main / fast); this is the exhaustive call-site inventory.

## The one rule

All *agentic* work — anything that drives the tool loop — runs on **main**, through the
router `LanguageModel`. Everything else is a **one-shot helper call** and goes through
`UtilityLlm.complete(prompt, { role: "fast" })`. Web search is the deliberate exception
(a provider-server-side tool, not a chat completion). No other module may call a
provider SDK.

## Inference call sites

| # | call site | purpose | service → selection | spend lands in |
|---|-----------|---------|---------------------|----------------|
| 1 | `core/usecases/agentLoop.ts` (`LanguageModel.generateText`, one per turn) | the **root conversation** — every turn of every mode (TUI / print / json / rpc) | router → **main** (`ModelRegistry.current`, per call) | gauge (`inputTokens` = last turn) · `byRole.main` · persisted on the assistant message (`providerOptions.efferent`) · per-turn `N tok` tree detail |
| 2 | same loop, run by `runSpawnedAgent` (`buildScopeRuntime.ts`) | **sub-agents** — every `run_agent` spawn/branch/handoff/resume + the human node-resume | router → **main** (delegation changes the context, not the brain) | node `usage` (`ContextTreeStore`) · shared per-turn **token pool** drain · agents-block row tokens · `byRole.main` — never the gauge |
| 3 | `core/usecases/handoff.ts` (`generateHandoffBrief`) | **handoff briefs** — `:handoff` (fold-in-place) and `run_agent seedMode:"handoff"` seeds | `LanguageModel` direct → router → **main** (quality-critical: the brief *is* the continuity) | **nowhere — known gap** (not evented, not in `byRole`) |
| 4 | `core/usecases/generateTitle.ts` (`generateSessionTitle`) | **session titles** after a session's first exchange | `UtilityLlm` → **fast** (`fastModel` ?? main) | `byRole.fast` (fed by the title daemon in `actions/submit.ts`) |
| 5 | `adapters/src/llm/webSearch.ts` (`WebSearchLive`, grounding-only `generateText`) | the **`search_web` tool** — a dedicated request carrying only the provider's server-side search tool | own per-call client (NOT the router): `Settings.searchModel` → `EFFERENT_SEARCH_MODEL` env → logged-in Google (preferred) / OpenAI | **nowhere — known gap** |
| 6 | `evals/src/framework/scorers.ts` (`llmJudge`) | **eval scoring** (LLM-as-judge) | the eval env's model layer; keys from `EnvAuthStoreLive` (the only env-var key reading in the tree) | the eval report only (out-of-app by design) |
| 7 | eval suites running the real loop (`runCoder`, the handoff suite) | **eval tasks** | same as #1 under the eval env | eval report only |
| 8 | `core/usecases/compaction.ts` (`compressToolResults`, called per loop step) | **compaction middle digests** — a ≤120-word summary of an oversized tool result's dropped middle, woven into the clip marker | `UtilityLlm` → **fast** (`fastModel` ?? main) — the fast role's first consumer | `byRole.fast` (via the `onHelperUsage` hook → `helper_usage` event; sub-agent loops forward to the parent ledger) |
| 9 | `core/usecases/autoApproval.ts` (`judgeApproval`), consulted by the TUI `Approval` impl (`tui-solid/approval.ts`) | **auto-approval judgments** — classify an unmatched bash command against the permitted folders: allow silently or escalate to the modal (never bypasses a prompt; `:set autoApprove off` disables) | `UtilityLlm` → **fast** (`fastModel` ?? main) | `byRole.fast` (counted directly by the approval impl, like the title daemon) |

## How a selection becomes a client

The router (and `UtilityLlm`, and web search) build the provider client **per call** via
`makeProviderLanguageModel` (`adapters/src/llm/providers.ts`): Google / OpenAI (plus the
Codex OAuth variant in `openAiCodex.ts`) / Anthropic (API key or subscription OAuth with
the Claude-Code system block) / OpenCode (`openCode.ts`) / Ollama (`ollama.ts`). Keys come
from `AuthStore.resolveKey` per call (refreshing near-expiry OAuth first), so `:login`,
`:model`, and `:set …Model` all apply on the next call with no rebuild.

## Non-inference provider traffic

Not model usage, listed for completeness: `ModelRegistry.list` (the live catalogue —
Google/OpenAI/Anthropic models endpoints, logged-in providers only) and OAuth token
refresh. Neither bills tokens.

## Accounting summary

`SessionStats.byRole {main, fast}` is the session ledger (`Σ` line in Activity):
root + sub-agent loop usage → **main**; helper calls → **their tier**, reported by
`UtilityLlm`'s `{ text, usage }` return. Rebuilt (resumed) sessions recover main only —
node spend stays on nodes (`:tree` shows it per agent).

**Known gaps** (uncounted spend): handoff briefs (#3) and web search (#5). Both are real
billed tokens; routing their usage into `byRole` is the next accounting slice — web
search would need `WebSearch` to return usage alongside `{ answer, sources }`, and the
handoff path would need `generateHandoffBrief` to report usage to its caller.
