---
"@xandreed/sdk-adapters": patch
---

verify gate: don't cut off a slow Opus review. The clean-room `claude` deliverable/learning gate had a hard 3-minute timeout, so a real multi-file review hit `ShellTimeout` and returned `unavailable` — and the self-improving loop can't validate → can't iterate. The cap is now 30 minutes (override with `EFFERENT_VERIFY_TIMEOUT_MS`), and the gate logs its model, repo-access, isolation, and **duration**, plus a clear actionable reason on timeout/failure (surfaced to the model as the gate's `reasons`, not just a bare tag).
