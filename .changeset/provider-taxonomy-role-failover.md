---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": patch
---

Provider-defect taxonomy + role-scoped failover: the runtime now understands WHY a model call died and heals what it can.

New shared classifier (`classifyProviderError` → `transient | quota | config | auth | model`) gives a typed home to every anonymous node-killer from the run forensics: opencode `CreditsError: Insufficient balance`, weekly/daily usage limits, the multi-hour daily-quota `Retry-After` (now `quota`, never slept on), kimi's `invalid thinking` 400 and provider-endpoint 404s (`config`), credential rejections (`auth`), and undecodable model output (`model`). `retryableLlm` consumes the same taxonomy for its transient decision — one classification, two consumers.

On a **persistent** defect (`quota`/`config`) the router now fails over ONCE to a human-configured selection instead of dying: the code role falls back to the run's pinned general model, the general role to the new `Settings.fallbackModel` (unset ⇒ no failover). Loud by construction — the notice rides the retry sink into the rail/node log/health suffix, spans carry `llm.failover.*`, and a `[failover: … → … after quota]` annotation is folded into the run's terminal outcome notes. `auth` never fails over (credentials are the human's — surfaces with the `:login` hint); `transient` still retries in place; `model` stays with the loop's corrective recovery. A running agent still never picks its own model.
