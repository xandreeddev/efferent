---
title: Settings
description: The Settings knobs — model selection, the agent loop, compaction, sub-agents, approval, telemetry, and the TUI.
sidebar:
  label: Settings
  order: 7
---

`Settings` (`@xandreed/sdk-core/entities/Settings.ts`) is a Schema-backed record, layered
**defaults < global (`~/.efferent/config.json`) < local (`<cwd>/.efferent/config.json`)**. In the TUI,
most are set with `:set <key> <value>`; `model`/`fastModel` also via `/model` and `:model fast`.

## Models

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `google:gemini-3.5-flash` | The main model, `"<provider>:<modelId>"`. |
| `fastModel` | *(follows main)* | The [fast helper tier](/docs/concepts/providers/). |
| `searchModel` | *(auto)* | Dedicated model for `search_web`. |
| `anthropicThinkingEffort` / `openAiReasoningEffort` / `geminiThinkingLevel` / `openCodeThinkingMode` | provider-specific | Extended-thinking / reasoning effort per provider. |

## Loop, compaction & sub-agents

| Key | Default | Meaning |
| --- | --- | --- |
| `maxSteps` | `20` | Max turns in one run. |
| `toolResultMaxTokens` | `4000` | Per-tool-result compaction budget (≈ chars/4; `0` = off). |
| `autoHandoffPct` | `85` | Auto-fold the context when a turn crosses this % of the window (`0` = off). |
| `subAgentTokenBudget` | `1_000_000` | Shared token pool across a turn's subtree (`0` = off). |
| `subAgentMaxSteps` | `80` | Per-sub-agent step cap. |

## Approval & bash

| Key | Default | Meaning |
| --- | --- | --- |
| `allowBash` | — | Static gate for bash in non-interactive modes (`--allow-bash`). |
| `autoApprove` | `on` | The fast-tier auto-approval judge for unmatched bash commands. |
| `approvedBashRules` / `approvedFolders` | `[]` | Persisted "always allow" rules / folders. |

## Telemetry & UI

| Key | Default | Meaning |
| --- | --- | --- |
| `telemetry` | `off` | The **sole** switch for [OTLP export](/docs/concepts/observability/). |
| `grafanaUrl` | `http://localhost:3000` | Base for the `:traces` / `:dashboard` deep-links. |
| `theme` | `efferent` | TUI theme (`efferent` / `one-dark` / `tokyo-night`). |
| `autoCollapse` | `off` | Fold previous turns when sending a new message. |
| `editorMode` | `insert` | Composer editing mode. |

The conversation store is **not** a `:set` key — it's chosen by `EFFERENT_DB_URL` or `:db` (see the CLI
reference).
